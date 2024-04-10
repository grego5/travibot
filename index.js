import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import dontenv from "dotenv";

import express from "express";
import bodyParser from "body-parser";
import {
  HttpClient,
  fragments,
  Storage,
  FarmList,
  TroopSetup,
  parseTribesData,
  RallyManager,
  Raid,
  TileGetter,
  main,
  mapExplorer,
  WebSocketServer,
} from "./src/index.js";

dontenv.config();

const wss = new WebSocketServer(3001);
const { json } = bodyParser;
const app = express();
app.use(json());
const port = 3000;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://" + process.env.HOSTNAME);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Private-Network", true);
  next();
});

const browser = new HttpClient({
  username: process.env.LOGIN,
  password: process.env.PASSWORD,
  hostname: process.env.HOSTNAME,
  headers: {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": "en-US,en;q=0.9,he-IL;q=0.8,he;q=0.7,ru-RU;q=0.6,ru;q=0.5",
    "cache-control": "max-age=0",
    "content-type": "application/x-www-form-urlencoded",
    "sec-ch-ua-mobile": "?1",
    "sec-ch-ua-platform": '"Android"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  },
});
const api = new HttpClient({
  username: process.env.LOGIN,
  password: process.env.PASSWORD,
  hostname: process.env.HOSTNAME,
  headers: {
    accept: "application/json, text/javascript, */*; q=0.01",
    "accept-language": "en-US,en;q=0.9,he-IL;q=0.8,he;q=0.7,ru-RU;q=0.6,ru;q=0.5",
    "sec-ch-ua": '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
    "sec-ch-ua-mobile": "?1",
    "sec-ch-ua-platform": '"Android"',
    "content-type": "application/json; charset=UTF-8",
    "x-requested-with": "XMLHttpRequest",
    "x-version": "2435.8",
  },
});
const storage = new Storage("store.json", [
  ["tileList", {}],
  ["raidList", {}],
  ["reports", {}],
  ["map", {}],
  ["raidArrays", {}],
  ["rallyCron", []],
]);

app.post("/rally", (req, res) => {
  const data = req.body;
  if (!data) req.send("queue-rally: No data");

  const rallyCron = storage.get("rallyCron");
  rallyCron.push(data);
  rallyCron.sort((a, b) => a.departDate - b.departDate);
  storage.save();
  res.send(JSON.stringify(rallyCron));
});
app.post("/autoraid", (req, res) => {
  const { did, autoraid } = req.body;

  const map = storage.get("map");
  map[did].autoraid = autoraid;
  storage.save();
  res.send(`autoraid ${autoraid ? "enabled" : "disabled"}`);
});
app.get("/storage", (req, res) => {
  const data = storage.getAll();
  data.villageTroops = app.get("villageTroops").getAll();
  res.send(JSON.stringify(data));
});
app.get("/get-village-troops", (req, res) => {
  const villageTroops = app.get("villageTroops");
  const { did } = req.query;
  const data = villageTroops.get(did);
  res.send(JSON.stringify(data));
});
app.get("/explore", (req, res) => {
  const { did, x, y } = req.query;
  if (!did) res.send("explorer: No data");

  mapExplorer({ did, storage, tileGetter, farmList, coords: { x, y }, callback: (data) => res.send(data) });
});
wss.setRoute("rallyCron", ({ action, troopsAction }, client) => {
  const rallyCron = storage.get("rallyCron");
  switch (action) {
    case "get":
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(rallyCron));
      }
      return;
    case "add":
      rallyCron.push(troopsAction);
      break;
    case "update":
      const update = rallyCron.find(({ key }) => key === troopsAction.key);
      if (!update) throw new Error(`troopsAction ${troopsAction.key} to update not found`);
      Object.assign(update, troopsAction);
      break;
    case "remove":
      const i = rallyCron.findIndex(({ key }) => key === troopsAction.key);
      if (i === -1) throw new Error(`troopsAction ${troopsAction.key} to remove not found`);
      rallyCron.splice(i, 1);
  }

  rallyCron.sort((a, b) => a.departDate - b.departDate);
  storage.save();
});

(async () => {
  let pageQuery = fragments.troops + fragments.hero;
  const callbackArray = [];

  if (!storage.get("tribes")) {
    pageQuery += fragments.tribes;
    callbackArray.push(function (data) {
      const tribes = parseTribesData(data.bootstrapData.tribes);
      storage.set("tribes", tribes);
    });
  }

  const query = `query {
      statistics {
        gameWorldProgress { stages { time } }
      },
      ownPlayer {
        id, tribeId,
        goldFeatures { goldClub },
        village { id, name, x, y },
      }
      ${pageQuery}
    }`;

  const data = await api.graphql({ query, callbackArray, logEvent: "init" });
  if (!data) return;

  const raidList = {};
  const tribes = storage.get("tribes");
  const map = storage.get("map");
  const { hero, villages, id: ownId, tribeId, goldFeatures } = data.ownPlayer;
  const { time: startDate } = data.statistics.gameWorldProgress.stages[0];
  const nextStageDate = startDate * 1000 + 4.32e8 - 7.2e6;
  const goldClub = !!goldFeatures.goldClub;

  const unitsData = tribes[tribeId];

  const tileGetter = new TileGetter({ browser, api, storage, tribes });
  const rallyManager = new RallyManager({ browser, api, storage, unitsData });
  const farmList = new FarmList({ api, storage });
  hero.idleSince = 0;

  villages.forEach((village) => {
    const did = village.id;

    if (!map[did]) {
      map[did] = { targets: [] };
      farmList.getListsFor(village).then((lists) => {
        const list = lists.find((list) => list.name === village.name);
        if (list) map[did] = farmList.linkList({ list, village: map[did] });
      });
    }

    village.troops.moving.edges.forEach(({ node }) => {
      const { time, units, player, troopEvent } = node;
      if (player.id !== ownId) return;
      const { arrivalTime, type: eventType, cellTo, cellFrom } = troopEvent;

      for (const id in units) if (!units[id]) delete units[id];
      const troops = rallyManager.troopsFrom(units);
      const travelTime = (arrivalTime - time) * 1000;
      const returnTime = units.t11 ? rallyManager.heroReturnTime({ hero, travelTime }) : travelTime;
      const arrivalDate = eventType === 9 ? arrivalTime * 1000 - travelTime : arrivalTime * 1000;
      const returnDate = eventType === 9 ? arrivalTime * 1000 : eventType === 5 ? 0 : arrivalDate + travelTime;
      const kid = eventType === 9 ? cellFrom.id : cellTo.id;
      const to = {
        x: eventType === 9 ? cellFrom.x : cellTo.x,
        y: eventType === 9 ? cellFrom.y : cellTo.y,
      };
      const from = {
        x: eventType === 9 ? cellTo.x : cellFrom.x,
        y: eventType === 9 ? cellTo.y : cellFrom.y,
        name: eventType === 9 ? cellTo.village.name : cellFrom.village.name,
      };
      const eventName = { [unitsData.scout.id]: "scout", t11: "hero" }[troops[0].id] || "raid";
      const raid = new Raid({
        did,
        from,
        to,
        eventName,
        eventType,
        travelTime,
        returnTime,
        arrivalDate,
        returnDate,
        units,
      });

      const raids = raidList[kid] || (raidList[kid] = []);
      raids.push(raid);
      raids.sort((a, b) => {
        const dateA = a.eventType === 9 ? a.returnDate : a.arrivalDate;
        const dateB = b.eventType === 9 ? b.returnDate : b.arrivalDate;
        return dateA - dateB;
      });

      if (units.t11) hero.idleSince = returnDate;
    });
  });

  storage.set("raidList", raidList);

  const villageTroops = new TroopSetup({ storage, hero, villages, unitsData });

  const state = {
    storage,
    nextStageDate,
    rallyManager,
    tileGetter,
    farmList,
    ownId,
    unitsData,
    villageTroops,
    villages,
    goldClub,
    wss,
    api,
  };

  main(state);
  app.set("villageTroops", villageTroops);

  app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
  });
})();
