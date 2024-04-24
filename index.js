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

const api = new HttpClient({
  username: process.env.LOGIN,
  password: process.env.PASSWORD,
  hostname: process.env.HOSTNAME,
});
const storage = new Storage("store", [
  { key: "map", value: {} },
  { key: "tileList", value: {} },
  { key: "reports", value: {} },
  { key: "raidList", value: {}, volatile: true },
  { key: "villageTroops", value: {}, volatile: true },
  { key: "rallyCron", value: [] },
  { key: "raidArrays", value: {} },
  { key: "raidIncome", value: { amount: 0, since: 0 } },
  { key: "tribes", value: null },
]);

(async () => {
  // await api.login();
  let pageQuery = fragments.hero + fragments.troops;
  const callbackArray = [];

  if (!storage.get("tribes")) {
    pageQuery += fragments.tribes;
    callbackArray.push(function (data) {
      const tribes = parseTribesData(data.bootstrapData.tribes);
      storage.set("tribes", tribes);
    });
  }

  const query = `query{bootstrapData{releaseVersion}statistics{gameWorldProgress{stages{time}}},ownPlayer{id,tribeId,goldFeatures{goldClub}}${pageQuery}}`;

  const data = await api.graphql({ query, callbackArray, logEvent: "init" });
  if (!data) return;

  const { tribes, map, tileList, reports, rallyCron, raidArrays } = storage.getAll();
  api.setHeader("x-version", data.bootstrapData.releaseVersion);
  const { hero, villages, id: ownId, tribeId, goldFeatures } = data.ownPlayer;
  const { time: startDate } = data.statistics.gameWorldProgress.stages[0];
  const noobEndingDate = startDate * 1000 + 4.32e8 - 7.2e6;
  const goldClub = !!goldFeatures.goldClub;

  const unitsData = tribes[tribeId];

  const tileGetter = new TileGetter({ api, storage });
  const rallyManager = new RallyManager({ api, storage, unitsData });
  const farmList = new FarmList({ api, storage });
  hero.idleSince = 0;

  const raidList = {};
  villages.forEach((village) => {
    const did = village.id;

    if (!map[did]) {
      map[did] = {
        targets: [],
        autoraid: 0,
        autosettings: {
          raid: { t1: 0, t2: 0, t3: 0, t4: 0, t5: 0, t6: 0, t7: 0, t8: 0, t9: 0, t10: 0, t11: 0 },
          escape: { t1: 1, t2: 1, t3: 1, t4: 1, t5: 1, t6: 1, t7: 1, t8: 1, t9: 1, t10: 1, t11: 1 },
        },
      };
      farmList.getListsFor(village).then((lists) => {
        const list = lists.find((list) => list.name === village.name);
        if (list) map[did] = farmList.linkList({ list, village: map[did] });
      });
    }

    village.troops.moving.edges.forEach(({ node }) => {
      const { time, units, player, troopEvent } = node;
      if (player.id !== ownId) return;
      const { arrivalTime, type: eventType, cellTo, cellFrom } = troopEvent;
      const toDelete = [];
      const troops = [];
      for (const id in units)
        if (!units[id]) toDelete.push(id);
        else troops.push(id);
      toDelete.forEach((id) => delete units[id]);
      const travelTime = (arrivalTime - time) * 1000;
      const returnTime = units.t11 && eventType !== 9 ? rallyManager.heroReturnTime({ hero, travelTime }) : travelTime;
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

      const eventName =
        troops.length === 1
          ? { [unitsData.scout.id]: "scout", t11: "hero" }[troops[0]] || "loot"
          : { 3: "attack", 4: "raid", 9: "raid" }[eventType];

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

  const villageTroops = new TroopSetup({ storage, hero, villages, tribes, tribeId });

  storage.set("raidList", raidList);
  storage.set("villageTroops", villageTroops.getAll());

  const state = main({
    storage,
    noobEndingDate,
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
  });

  app.post("/rally", (req, res) => {
    const data = req.body;
    if (!data) req.send("queue-rally: No data");

    rallyCron.push(data);
    rallyCron.sort((a, b) => a.departDate - b.departDate);
    storage.save(["rallyCron"]);
    res.send(JSON.stringify(rallyCron));
  });
  app.post("/autoraid", (req, res) => {
    const { did, autoraid } = req.body;
    map[did].autoraid = autoraid;
    storage.save(["map"]);
    res.send(`autoraid ${autoraid ? "enabled" : "disabled"}`);
  });
  app.get("/storage", (req, res) => {
    const q = Number(req.query.q);
    if (typeof q !== "number" && isNaN(q)) {
      res.status(400).send(JSON.stringify({ error: "Bad Request: Invalid parameters" }));
    }

    const store = storage.getAll();
    const { keys } = storage;

    const data =
      q > 0
        ? keys.reduce((acc, key, b) => {
            if (q & (1 << b)) acc[key] = store[key];
            return acc;
          }, {})
        : { ...store };

    res.send(JSON.stringify(data));
  });
  app.post("/explore", async (req, res) => {
    const village = req.body;
    if (!village) res.status(400).send("explorer: No data");

    const did = village.id;
    const area = map[did];
    state.async = Date.now();
    const { targets, tileUpdates } = await tileGetter.explore(village.x, village.y);

    const lists = await farmList.getListsFor(village);
    const list = lists.find((list) => list.name === village.name);
    if (!list) {
      const list = await farmList.createFor(village);
      area.listId = list.id;
      await farmList.createSlots({ listId: list.id, targets });
    } else area.listId = list.id;

    const { listId } = area;
    area.targets = await farmList.linkTargets({ listId, targets });
    area.autoraid = 0;

    tileUpdates.forEach(({ tile, report, kid }) => {
      const { id, distance } = area.targets.find((t) => t.kid === kid);
      const village = { did, distance, listId, targetId: id };
      if (kid in tileList) {
        tileList[kid].villages.every((village) => village.did !== did) && tileList[kid].villages.push(village);
      } else {
        tile.villages = [village];
        tileList[kid] = tile;
      }
      reports[kid] = report;
    });

    const troopsData = villageTroops.get(did);
    targets.forEach((target) => troopsData.assign(target));

    storage.save(["map", "tileList", "reports"]);

    state.async = 0;

    res.status(200).send();
  });

  wss.setRoute("rallyCron", ({ action, troopsAction }, client) => {
    switch (action) {
      case "get":
        if (client.readyState === WebSocket.OPEN) {
          const data = {
            event: "rallyCron",
            timestamp: Math.floor(Date.now() / 1000) * 1000,
            payload: JSON.stringify(rallyCron),
          };
          const message = JSON.stringify(data);
          client.send(message);
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
    storage.save(["rallyCron"]);
  });
  wss.setRoute("raidArray", ({ did, raidArray }, client) => {
    raidArray ? (raidArrays[did] = raidArray) : delete raidArrays[did];
    storage.save(["raidArrays"]);
  });
  wss.setRoute("autosettings", ({ did, autosettings }, client) => {
    map[did].autosettings = autosettings;
    storage.save(["map"]);
    const { assign } = villageTroops.get(did);
    map[did].targets.forEach((target) => assign(target));
  });

  app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
  });
})();
