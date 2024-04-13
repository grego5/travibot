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
  { key: "explorer", value: null },
]);

(async () => {
  let pageQuery = fragments.statusQuery;
  const callbackArray = [];

  if (!storage.get("tribes")) {
    pageQuery += fragments.tribes;
    callbackArray.push(function (data) {
      const tribes = parseTribesData(data.bootstrapData.tribes);
      storage.set("tribes", tribes);
    });
  }

  const query = `query{statistics{gameWorldProgress{stages{time}}},ownPlayer{id,tribeId,goldFeatures{goldClub}}${pageQuery}}`;

  const data = await api.graphql({ query, callbackArray, logEvent: "init" });
  if (!data) return;

  const { tribes, map, rallyCron, raidArrays } = storage.getAll();
  const { hero, villages, id: ownId, tribeId, goldFeatures } = data.ownPlayer;
  const { time: startDate } = data.statistics.gameWorldProgress.stages[0];
  const noobEndingDate = startDate * 1000 + 4.32e8 - 7.2e6;
  const goldClub = !!goldFeatures.goldClub;

  const unitsData = tribes[tribeId];

  const tileGetter = new TileGetter({ api, storage, tribes });
  const rallyManager = new RallyManager({ api, storage, unitsData });
  const farmList = new FarmList({ api, storage });
  hero.idleSince = 0;

  const raidList = {};
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

  const villageTroops = new TroopSetup({ storage, hero, villages, tribes, tribeId });

  storage.set("raidList", raidList);
  storage.set("villageTroops", villageTroops.getAll());

  const state = {
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
  };
  main(state);

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
  app.get("/explore", (req, res) => {
    const { did, x, y } = req.query;
    if (!did) res.send("explorer: No data");

    mapExplorer({ did, storage, tileGetter, farmList, coords: { x, y }, callback: (data) => res.send(data) });
  });
  wss.setRoute("rallyCron", ({ action, troopsAction }, client) => {
    switch (action) {
      case "get":
        if (client.readyState === WebSocket.OPEN) {
          const data = { event: "rallyCron", timestamp: Date.now(), payload: JSON.stringify(rallyCron) };
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
  app.get("/login", async (req, res) => {
    const { did, unit, count, kid } = req.query;
    const defaultHeders = {
      accept: "application/json, text/javascript, */*; q=0.01",
      "accept-language": "en-US,en;q=0.9,he-IL;q=0.8,he;q=0.7,ru-RU;q=0.6,ru;q=0.5",
      "content-type": "application/json; charset=UTF-8",
      "sec-ch-ua": '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
      "sec-ch-ua-mobile": "?1",
      "sec-ch-ua-platform": '"Android"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "x-requested-with": "XMLHttpRequest",
      "x-version": "2435.8",
    };

    const login = async () => {
      try {
        const { code } = await fetch("https://ts3.x1.europe.travian.com/api/v1/auth/login", {
          method: "POST",
          headers: defaultHeders,
          referrer: "https://ts3.x1.europe.travian.com/",
          referrerPolicy: "strict-origin-when-cross-origin",
          body: JSON.stringify({
            name: "1type568@gmail.com",
            password: "19gjmPTW88",
            w: "1920:1080",
            mobileOptimizations: true,
          }),
        }).then((res) => res.json());

        const data = await fetch("https://ts3.x1.europe.travian.com/api/v1/auth?code=" + code, {
          method: "GET",
          headers: defaultHeders,
          referrer: "https://ts3.x1.europe.travian.com/",
          referrerPolicy: "strict-origin-when-cross-origin",
        }).then((res) => res.headers.get("Set-Cookie"));
        const token = data.substring(4, data.indexOf(";"));

        return token;
      } catch (error) {
        console.error(error);
      }
    };

    await (async () => {
      const token = await login();
      const parts = token.split(".");
      const decodedPayload = Buffer.from(parts[1], "base64").toString("utf-8");
      console.log("token 1: ", decodedPayload);

      const headers = { ...defaultHeders, cookie: `JWT=${token}; SameSite=None; Secure` };
      await fetch(`https://ts3.x1.europe.travian.com/api/v1/village/${did}/update-sort-index`, {
        headers,
        referrer: "https://ts3.x1.europe.travian.com/dorf1.php",
        referrerPolicy: "strict-origin-when-cross-origin",
        body: JSON.stringify({ to: 1 }),
        method: "POST",
        mode: "cors",
        credentials: "include",
      });
    })();

    const cookie = await (async () => {
      const token = await login();
      const parts = token.split(".");
      const decodedPayload = Buffer.from(parts[1], "base64").toString("utf-8");
      console.log("token 2: ", decodedPayload);

      const body = {
        action: "troopsSend",
        targetMapId: Number(kid),
        eventType: 4,
        troops: [{ [unit]: Number(count), villageId: Number(did) }],
      };

      const headers = { ...defaultHeders, cookie: `JWT=${token}; SameSite=None; Secure` };
      await fetch("https://ts3.x1.europe.travian.com/api/v1/troop/send", {
        headers,
        referrer: "https://ts3.x1.europe.travian.com/hero/adventures",
        referrerPolicy: "strict-origin-when-cross-origin",
        body: JSON.stringify(body),
        method: "PUT",
        mode: "cors",
        credentials: "include",
      }).then(async (res) => {
        const cookie = res.headers.get("Set-Cookie");
        const parts = cookie.split(".");
        const decodedPayload = Buffer.from(parts[1], "base64").toString("utf-8");
        console.log("token 3", decodedPayload);
        return cookie;
      });

      await new Promise((res) => setTimeout(() => res(), 1000));

      const cookie = await fetch("https://ts3.x1.europe.travian.com/api/v1/troop/send", {
        headers,
        referrer: "https://ts3.x1.europe.travian.com/hero/adventures",
        referrerPolicy: "strict-origin-when-cross-origin",
        body: JSON.stringify(body),
        method: "PUT",
        mode: "cors",
        credentials: "include",
      }).then(async (res) => {
        const cookie = res.headers.get("Set-Cookie");
        const parts = cookie.split(".");
        const decodedPayload = Buffer.from(parts[1], "base64").toString("utf-8");
        console.log("token 4", decodedPayload);
        const data = await res.json();
        console.log(data);
        return cookie;
      });

      return cookie;
    })();

    res.send(cookie);
  });

  app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
  });
})();
