import { xy2id } from "./functions.js";
import Raid from "./Raid.js";
import { JSDOM } from "jsdom";
import fs from "fs";

function parseTravelTime(string) {
  const digits = string.split(" ")[1].split(":");
  return +digits[0] * 1000 * 60 * 60 + +digits[1] * 1000 * 60 + +digits[2] * 1000;
}

export default class RallyManager {
  constructor({ browser, api, storage }) {
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
    this.tribeId = null;
    this.scoutId = null;
    this.unitsData = null;
  }

  setTribe = (tribeId, scoutId) => {
    this.tribeId = tribeId;
    this.scoutId = scoutId;
    this.unitsData = this.storage.get("tribesData")[tribeId];
  };

  heroReturnTime = async (travelTime) => {
    const query = `
    query {
      ownPlayer {
        hero {
          equipment {
            leftHand {
              attributes {
                value
                effectType
              }
            }
          }
        }
      }
    }
  `;

    const {
      ownPlayer: {
        hero: {
          equipment: { leftHand },
        },
      },
    } = await this.api.graphql({ query });

    if (!leftHand) return travelTime;

    const {
      attributes: [{ value, effectType }],
    } = leftHand;

    return effectType === "MORE_RETURN_SPEED" ? Math.round(travelTime / (value / 100 + 1)) : travelTime;
  };

  troopsFrom = (units) => {
    const troops = [];

    if (!this.unitsData) {
      console.log("Tribe is not set. setTribe(tribeId)");
      return troops;
    }

    for (const id in units) {
      const count = units[id];
      if (!count) continue;
      const { name, icon, speed } = this.unitsData[id];
      troops.push({ name, icon, speed, id, count });
    }
    return troops;
  };

  createRally = ({ did, coords, units = [], troops, eventName, eventType = 4 }) => {
    const _troops = troops || this.troopsFrom(units);
    const scouting = +(_troops.length === 1 && !!_troops.find((unit) => unit.id === this.scoutId));

    const scoutTarget = "&troop%5BscoutTarget%5D=1";
    const body = `eventType=${eventType}&x=${coords.x}&y=${coords.y}${_troops.reduce(
      (acc, { id, count }) => (acc += `&troop%5B${id}%5D=${count}`),
      ""
    )}${scouting ? scoutTarget : ""}&ok=ok`;

    const rally = { body, did, coords, eventName, troops: _troops };
    rally.dispatch = () => this.dispatchRally(rally);
    return rally;
  };

  dispatchRally = async (rally) => {
    const { body, did, coords, eventName, eventType = 4, troops, catapultTargets = [] } = rally;

    const res = await this.browser.submitRally.POST({ body, params: [["newdid", did]] });
    const html = await res.text();
    const dom = new JSDOM(html);
    const form = dom.window.document.getElementById("troopSendForm");
    const confirm = form.querySelector("button.rallyPointConfirm");
    const checksum = confirm.getAttribute("onclick").match(/'([^']+)';/)[1];

    let params = "";
    let hero = false;
    for (const { name, value } of form.elements) {
      if (value) {
        params += `${name}=${value}&`;
        if (name === "troops[0][t11]" && Number(value)) hero = true;
      }
    }
    params += `checksum=${checksum}`;

    if (catapultTargets.length) {
      params += `&troops[0][catapultTarget1]=${catapultTargets[0]}`;
      if (catapultTargets[1]) params += `&troops[0][catapultTarget2]=${catapultTargets[1]}`;
    }

    const kid = xy2id(coords);
    this.browser.submitRally
      .POST({ body: params })
      .then(() => console.log(`Troops dispached to ${coords.x}|${coords.y} (${kid})`));

    const travelTime = parseTravelTime(form.querySelector("#in").textContent);
    const returnTime = hero ? await this.heroReturnTime(travelTime) : travelTime;

    const raid = new Raid({ did, coords, eventName, eventType, travelTime, returnTime, troops });
    console.log(raid);
    const raidList = this.storage.get("raidList");
    kid in raidList ? raidList[kid].push(raid) : (raidList[kid] = [raid]);
    raidList[kid].sort((a, b) => {
      const dateA = a.status >= 3 ? a.returnDate : a.arrivalDate;
      const dateB = b.status >= 3 ? b.returnDate : b.arrivalDate;
      return dateA - dateB;
    });
    this.storage.save();

    return raidList[kid];
  };
}
