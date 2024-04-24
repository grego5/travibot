import { Raid, xy2id } from "./index.js";

export default class RallyManager {
  constructor({ api, storage, unitsData }) {
    api.addRoutes([{ name: "sendTroops", path: "/api/v1/troop/send", methods: ["PUT", "POST"] }]);
    this.api = api;
    this.storage = storage;
    this.unitsData = unitsData;
    this.raidedTiles = new Set();
    this.raidingVillages = new Set();
    this.escapeEvents = {};
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

  createRally = ({ did, from, to, eventName, eventType = 4, units, hero, catapultTargets = [], scoutTarget }) => {
    const rally = { did, from, to, eventName, eventType, units, hero, catapultTargets, scoutTarget };
    rally.dispatch = () => this.sendTroops(rally);
    return rally;
  };

  async sendTroops(rally) {
    const { did, from, to, eventName, scoutTarget, eventType, units, hero, catapultTargets } = rally;
    const kid = xy2id(to);
    const troops = { ...units, villageId: did };
    catapultTargets.forEach((target, i) => (troops[`catapultTarget${i + 1}`] = target));
    if (scoutTarget) troops.scoutTarget = scoutTarget;

    const body = { action: "troopsSend", targetMapId: kid, eventType, troops: [troops] };

    try {
      const { headers } = await this.api.sendTroops.put({ body, villageId: did });

      const res = await this.api.sendTroops.post({
        body,
        logEvent: `${eventName} dispatch ${JSON.stringify(units)} to ${JSON.stringify(to)} ${kid}`,
        headers: {
          "X-Nonce": headers.get("X-Nonce"),
        },
        villageId: did,
      });
      const data = await res.json();
      const { timeArrive, timeStart, arrivalIn } = data.troops[0];

      const raid = new Raid({
        did,
        from,
        to,
        eventName,
        eventType,
        departDate: timeStart * 1000,
        units,
      });

      if (eventType === 5 && eventName === "escape") {
        const { returnDate } = this.escapeEvents[did];
        raid.travelTime = Math.min((returnDate - raid.departDate) / 2, 89000);
        raid.arrivalDate = raid.departDate + raid.travelTime;
        raid.returnDate = raid.arrivalDate + raid.travelTime;
        delete this.escapeEvents[did];
      } else {
        raid.travelTime = arrivalIn * 1000;
        raid.arrivalDate = timeArrive * 1000;
        raid.returnDate = hero ? this.heroReturnTime({ hero, travelTime: raid.travelTime }) : raid.travelTime;
      }

      const raidList = this.storage.get("raidList");
      const raids = raidList[kid] || (raidList[kid] = []);
      raids.push(raid);
      raids.sort((a, b) => {
        const dateA = a.eventType === 9 ? a.returnDate : a.arrivalDate;
        const dateB = b.eventType === 9 ? b.returnDate : b.arrivalDate;
        return dateA - dateB;
      });
      this.raidingVillages.add(did);
      this.raidedTiles.add(kid);

      return raid;
    } catch (error) {
      throw error;
    }
  }
}
