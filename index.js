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
  rallyCron.sort((a, b) => a.departure - b.departure);
  if (data.departure - Date.now() > 10000) {
    storage.save();
  }
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
  data.villageTroops = app.get("villageTroops").get();
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
  const villageTroops = new TroopSetup({ storage, hero, villages, unitsData });
  const rallyManager = new RallyManager({ browser, api, storage, unitsData });
  const farmList = new FarmList({ api, storage });

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
      const { arrivalTime, type, cellTo, cellFrom } = troopEvent;

      const troops = rallyManager.troopsFrom(units);
      const travelTime = (arrivalTime - time) * 1000;
      const returnTime = units.t11 ? rallyManager.heroReturnTime({ hero, travelTime }) : travelTime;
      const arrivalDate = type === 9 ? arrivalTime * 1000 - travelTime : arrivalTime * 1000;
      const returnDate = type === 9 ? arrivalTime * 1000 : type === 5 ? 0 : arrivalDate + travelTime;
      const kid = type === 9 ? cellFrom.id : cellTo.id;
      const coords = {
        x: type === 9 ? cellFrom.x : cellTo.x,
        y: type === 9 ? cellFrom.y : cellTo.y,
      };
      const eventName = { [unitsData.scout.id]: "scout", t11: "hero" }[troops[0].id] || "raid";
      const raid = new Raid({ did, coords, eventName, type, travelTime, returnTime, arrivalDate, returnDate, troops });

      const raids = raidList[kid] || (raidList[kid] = []);
      raids.push(raid);
      raids.sort((a, b) => {
        const dateA = a.type === 9 ? a.returnDate : a.arrivalDate;
        const dateB = b.type === 9 ? b.returnDate : b.arrivalDate;
        return dateA - dateB;
      });
    });
  });
  storage.set("raidList", raidList);

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
