import { Raid, xy2id } from "./index.js";
import { JSDOM } from "jsdom";

function parseTravelTime(string) {
  const digits = string.split(" ")[1].split(":");
  return +digits[0] * 1000 * 60 * 60 + +digits[1] * 1000 * 60 + +digits[2] * 1000;
}

export default class RallyManager {
  constructor({ browser, api, storage, unitsData }) {
    browser.addRoutes([
      {
        name: "submitRally",
        path: "/build.php",
        headers: { redirect: "manual" },
        methods: ["POST"],
        params: [
          ["gid", "16"],
          ["tt", "2"],
        ],
      },
    ]);

    api.addRoutes([{ name: "sendTroops", path: "/api/v1/troop/send", methods: ["PUT", "POST"] }]);

    this.browser = browser;
    this.api = api;
    this.storage = storage;
    this.unitsData = unitsData;
    this.raidedTiles = [];
    this.raidingVillages = [];
  }

  heroReturnTime = ({ hero, travelTime }) => {
    const {
      equipment: { leftHand },
    } = hero;

    if (!leftHand) return travelTime;

    const {
      attributes: [{ value, effectType }],
    } = leftHand;

    return effectType === "MORE_RETURN_SPEED" ? Math.round(travelTime / (value / 100 + 1)) : travelTime;
  };

  troopsFrom = (units) => {
    const troops = [];

    for (const id in units) {
      const count = units[id];
      if (!count) continue;
      const { name, icon, speed } = this.unitsData[id];
      troops.push({ name, icon, speed, id, count });
    }
    return troops;
  };

  createRally = ({ did, from, to, eventName, eventType = 4, troops, units, hero, catapultTargets = [] }) => {
    const _units =
      units ||
      troops.reduce((units, { id, count }) => {
        units[id] = count;
        return units;
      }, {});
    const _troops = troops || this.troopsFrom(units);
    const scoutTarget = eventName === "scout" ? 1 : 0;
    const rally = {
      did,
      from,
      to,
      eventName,
      eventType,
      troops: _troops,
      units: _units,
      hero,
      catapultTargets,
      scoutTarget,
    };
    rally.dispatch = () => this.sendTroops(rally);
    return rally;
  };

  dispatchRally = async (rally) => {
    const { did, from, to, eventName, eventType, troops, units, hero, catapultTargets = [] } = rally;

    const body = `eventType=${eventType}&x=${to.x}&y=${to.y}${troops.reduce(
      (acc, { id, count }) => (acc += `&troop%5B${id}%5D=${count}`),
      ""
    )}&ok=ok`;

    const res = await this.browser.submitRally.post({ body, params: [["newdid", did]] });
    const html = await res.text();
    const dom = new JSDOM(html);
    const form = dom.window.document.getElementById("troopSendForm");

    if (!form) {
      console.log("dispatch failed", body);
      return null;
    }

    const confirm = form.querySelector("button.rallyPointConfirm");
    const checksum = confirm.getAttribute("onclick").match(/'([^']+)';/)[1];

    let params = "";
    for (const { name, value } of form.elements) if (value) params += `${name}=${value}&`;
    params += `checksum=${checksum}`;

    if (catapultTargets.length) {
      params += `&troops[0][catapultTarget1]=${catapultTargets[0]}`;
      if (catapultTargets[1]) params += `&troops[0][catapultTarget2]=${catapultTargets[1]}`;
    }

    const kid = xy2id(to);
    this.browser.submitRally.post({
      body: params,
      logEvent: JSON.stringify(units) + ` => (${to.x}|${to.y}) (${kid})`,
    });

    const travelTime = parseTravelTime(form.querySelector("#in").textContent);
    const returnTime = hero ? this.heroReturnTime({ hero, travelTime }) : travelTime;

    const raid = new Raid({ did, from, to, eventName, eventType, travelTime, returnTime, troops });
    const raidList = this.storage.get("raidList");
    const raids = raidList[kid] || (raidList[kid] = []);
    raids.push(raid);
    raids.sort((a, b) => {
      const dateA = a.eventType === 9 ? a.returnDate : a.arrivalDate;
      const dateB = b.eventType === 9 ? b.returnDate : b.arrivalDate;
      return dateA - dateB;
    });
    this.raidingVillages.find((v) => v.did === did) || this.raidingVillages.push(did);
    this.raidedTiles.find((t) => {
      if (t.kid === kid) {
        t.raids = raids;
        return true;
      }
    }) || this.raidedTiles.push({ kid, raids });
    this.storage.save();

    return raids;
  };

  async sendTroops(rally) {
    const { did, from, to, eventName, scoutTarget, eventType, units, troops, hero, catapultTargets } = rally;
    const kid = xy2id(to);
    catapultTargets.forEach((target, i) => (units[`catapultTarget${i + 1}`] = target));
    if (scoutTarget) units.scoutTarget = scoutTarget;
    units.villageId = did;

    const body = { action: "troopsSend", targetMapId: kid, eventType, troops: [units] };

    try {
      const { headers } = await this.api.sendTroops.put({ body });

      const res = await this.api.sendTroops.post({
        body,
        logEvent: `${JSON.stringify(units)} ${eventName} (${to.x}|${to.y}) (${kid})`,
        headers: {
          "X-Nonce": headers.get("X-Nonce"),
        },
      });
      const data = await res.json();
      const { timeArrive, timeStart, arrivalIn } = data.troops[0];
      const travelTime = arrivalIn * 1000;
      const raid = new Raid({
        did,
        from,
        to,
        eventName,
        eventType,
        travelTime,
        returnTime: hero ? this.heroReturnTime({ hero, travelTime }) : travelTime,
        departDate: timeStart * 1000,
        arrivalDate: timeArrive * 1000,
        troops,
      });

      const raidList = this.storage.get("raidList");
      const raids = raidList[kid] || (raidList[kid] = []);
      raids.push(raid);
      raids.sort((a, b) => {
        const dateA = a.eventType === 9 ? a.returnDate : a.arrivalDate;
        const dateB = b.eventType === 9 ? b.returnDate : b.arrivalDate;
        return dateA - dateB;
      });
      this.raidingVillages.find((v) => v.did === did) || this.raidingVillages.push(did);
      this.raidedTiles.find((t) => {
        if (t.kid === kid) {
          t.raids = raids;
          return true;
        }
      }) || this.raidedTiles.push({ kid, raids });
      this.storage.save();

      return raids;
    } catch (error) {
      console.log(error);
      return;
    }
  }
}
