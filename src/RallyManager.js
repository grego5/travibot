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

    this.browser = browser;
    this.api = api;
    this.storage = storage;
    this.unitsData = unitsData;
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

  createRally = ({ did, coords, units = {}, troops, eventName, eventType = 4, hero }) => {
    const _troops = troops || this.troopsFrom(units);

    const body = `eventType=${eventType}&x=${coords.x}&y=${coords.y}${_troops.reduce((acc, { id, count }) => {
      acc += `&troop%5B${id}%5D=${count}`;
      units[id] = count;
      return acc;
    }, "")}&ok=ok`;

    const rally = { body, did, coords, eventName, troops: _troops, units, hero };
    rally.dispatch = () => this.dispatchRally(rally);
    return rally;
  };

  dispatchRally = async (rally) => {
    const { body, did, coords, eventName, eventType, troops, units, catapultTargets = [], hero } = rally;

    const res = await this.browser.submitRally.POST({ body, params: [["newdid", did]] });
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

    const kid = xy2id(coords);
    this.browser.submitRally.POST({
      body: params,
      logEvent: JSON.stringify(units) + ` => (${coords.x}|${coords.y}) (${kid})`,
    });

    const travelTime = parseTravelTime(form.querySelector("#in").textContent);
    const returnTime = hero ? this.heroReturnTime({ hero, travelTime }) : travelTime;

    const raid = new Raid({ did, coords, eventName, eventType, travelTime, returnTime, troops });
    const raidList = this.storage.get("raidList");
    const raids = raidList[kid] || (raidList[kid] = []);
    raids.push(raid);
    raids.sort((a, b) => {
      const dateA = a.type === 9 ? a.returnDate : a.arrivalDate;
      const dateB = b.type === 9 ? b.returnDate : b.arrivalDate;
      return dateA - dateB;
    });
    this.storage.save();

    return raids;
  };
}
