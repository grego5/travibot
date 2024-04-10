import { simCombat } from "./index.js";
const t1 = "t1";
const t11 = "t11";

export default class TroopSetup {
  constructor({ storage, hero, villages, unitsData }) {
    this.map = storage.get("map");
    this.allRaidArrays = storage.get("raidArrays");
    this.tileList = storage.get("tileList");
    this.reports = storage.get("reports");
    this.hero = hero;
    this.unitsData = unitsData;
    this.villages = {};
    this.villages = this.update({ hero, villages });
  }

  get = (did) => this.villages[did] || (this.villages[did] = {});
  getAll = () => this.villages;

  update = ({ hero, villages }) => {
    hero.idleSince = this.hero.idleSince;
    this.hero = hero;
    villages.forEach((village) => {
      const { id: did, name, x, y, troops } = village;
      const troopsData = {
        did,
        name,
        coords: { x, y },
        idleUnits: troops.ownTroopsAtTown.units,
        raidUnits: {},
        hero: this.hero.homeVillage.id === did ? this.hero : null,
        assign: (target) => this.assign(did, target),
      };
      Object.assign(this.get(village.id), troopsData);
      const { targets } = this.map[village.id];
      targets.forEach((target) => troopsData.assign(target));
    });
    return this.villages;
  };

  assign = (did, target) => {
    const now = Date.now();
    const { idleUnits, raidUnits, hero } = this.villages[did];
    const { kid, distance } = target;
    const report = this.reports[kid] || { scoutDate: 0, timestamp: now, loot: 0 };
    const { defense, guards } = this.tileList[kid];
    const { reward, idef, cdef } = defense;
    const raidArray = this.allRaidArrays[did];
    const isOldReport = now - report.timestamp > 2.16e7; // 6 hours
    const scouted = report.scoutDate === report.timestamp && now - report.timestamp < 2.16e7;
    const lootSum = reward + report.loot;
    const totalToDistance = lootSum / distance;

    const data = {
      units: {},
      forecast: {},
      eventName: "",
    };

    if (!guards.length && scouted && totalToDistance >= 100) {
      let id = null;
      let required = 0;

      for (let i = 1; i < 7; i++) {
        const unit = this.unitsData[id];
        const newId = "t" + String(i);
        const newUnit = this.unitsData[newId];
        const newRequired = Math.ceil(report.loot / newUnit.carry);
        const isAvaible = idleUnits[newId] >= newRequired;
        const isFaster = newUnit.speed / distance >= 0.8 && (!id || newUnit.speed > unit.speed);

        if (isAvaible && isFaster) (id = newId), (required = newRequired);
      }

      if (id) {
        data.eventName = "loot";
        data.units[id] = Math.min(idleUnits[id], required);
      }
    }

    if (hero && guards.length) {
      const isMounted = Boolean(hero.equipment.horse);

      const heroBonus = ["helmet", "body", "horse", "shoes"].reduce(
        (heroBonus, slot) => {
          hero.equipment[slot]?.attributes.forEach(({ effectType, value }) => {
            switch (effectType) {
              case "LESS_DAMAGE":
                heroBonus.damageReduction += value;
                break;
              case "MORE_EXPERIENCE":
                heroBonus.xp += value;
                break;
              case "MORE_MOUNTED_HERO_SPEED":
                heroBonus.mountSpeed += isMounted ? value : 0;
            }
          });

          return heroBonus;
        },
        { xp: 0, damageReduction: 0, mountSpeed: 0 }
      );

      const { value: power } = hero.attributes[0];
      const attacker = [{ id: t11, count: hero.health }];

      const footCombat = simCombat({
        infantryPower: power,
        infantryDefense: idef,
        cavaleryDefense: cdef,
        attacker,
        defender: guards,
      });

      const mountCombat = simCombat({
        cavaleryPower: power,
        infantryDefense: idef,
        cavaleryDefense: cdef,
        attacker,
        defender: guards,
      });

      const mountedRaid =
        mountCombat.result[0].count <= heroBonus.damageReduction ||
        distance / 7 > 0.8 ||
        mountCombat.result[0].count - footCombat.result[0].count < 2;

      const speed = 7 + mountedRaid ? Math.max(7, heroBonus.mountSpeed) : 0;
      const { result, alive, bounty, xp: _xp } = mountedRaid ? mountCombat : footCombat;
      const time = distance / speed;
      const xp = Math.round(_xp * (1 + heroBonus.xp / 100));
      const minXpToLoss = Math.min((5 / 20) * hero.level, Math.round((hero.xpForNextLevel / hero.health) * 10) / 10);

      const healthLoss = Math.max(result[0].count - heroBonus.damageReduction, 0);
      const percetLoss = Math.round((healthLoss / hero.health) * 100);
      const xpToLoss = Math.round(healthLoss ? (xp / healthLoss) * 10 : xp * 10) / 10;
      const bountyToLoss = Math.round(healthLoss ? bounty / healthLoss : bounty);
      const xpTime = Math.round(xp / time);
      const bountyTime = Math.round(bounty / time);

      const unmetConditions = [
        { check: bounty > 2000, reason: `bounty is low ${bounty}` },
        { check: percetLoss <= 80, reason: `loss is high ${percetLoss}` },
        { check: xpToLoss >= minXpToLoss, reason: `xp/loss is low ${xpToLoss}, min ${minXpToLoss}` },
        { check: isMounted === mountedRaid, reason: `hero is ${isMounted ? "mounted" : "afoot"}` },
        { check: hero.level < 40, reason: "hero level is high" },
      ].filter(({ check }) => !check);
      const ready = !unmetConditions.length;

      data.forecast = {
        for: "hero",
        mountedRaid,
        isMounted,
        unmetConditions,
        ready,
        xp,
        xpTime,
        xpToLoss,
        bounty,
        bountyTime,
        healthLoss: Math.round(healthLoss),
        percetLoss,
        alive,
        carriers: [],
        ratio: Math.trunc(healthLoss > 2 ? (bounty / (percetLoss * time) + bountyTime * 0.4) / 100 : bountyTime / 100),
      };

      if (!data.eventName && ready && idleUnits.t11) {
        data.eventName = "hero";
        data.units.t11 = 1;
      }
    }

    if (!data.eventName && raidArray) {
      let infantryPower = 0;
      let cavaleryPower = 0;
      let raidSpeed = 100;
      let raidCarry = 0;

      for (const id in raidArray) {
        const count = Math.min(idleUnits[id], raidArray[id]);
        const { name, icon, speed, attack, cost, carry } = this.unitsData[id];
        const troops = [];

        if (id !== t11) {
          speed > 8 ? (cavaleryPower += attack * count) : (infantryPower += attack * count);
        }

        if (count >= raidArray[id] * 0.8 && (id === t11 ? hero.health >= 33 : true)) {
          troops.push({ id, name, icon, speed, count, cost });
          if (speed < raidSpeed) raidSpeed = speed;
          raidCarry += carry;
        } else {
          troops.length = 0;
          break;
        }
      }

      if (troops.length) {
        const res = simCombat({
          infantryPower,
          cavaleryPower,
          infantryDefense: idef,
          cavaleryDefense: cdef,
          attacker: troops,
          defender: guards,
        });

        if (res.resourcesLost / 600 > 2) {
          const { name, icon, speed, attack, cost, carry } = this.unitsData[t1];
          const count = idleUnits[t1] >= 1000 ? Math.max(2000, idleUnits[t1]) : Math.ceil(2000 / attack);

          if (idleUnits[t1] >= count) {
            infantryPower += attack * count;
            troops.push({ id: t1, name, icon, speed, count, cost });
            if (speed < raidSpeed) raidSpeed = speed;
            raidCarry += carry;
          } else {
            troops.length = 0;
          }
        }
      }

      if (troops.length) {
        const { result, alive, bounty, xp, resourcesLost } = simCombat({
          infantryPower,
          cavaleryPower,
          infantryDefense: idef,
          cavaleryDefense: cdef,
          attacker: troops,
          defender: guards,
        });
        const time = distance / raidSpeed;
        const bountySum = bounty - resourcesLost;
        const loot = Math.min(report.loot, raidCarry);

        const xpTime = Math.round(xp / time);
        const bountyTime = Math.round(bountySum / time);
        const ready = bountyTime > 1000 && bounty > 5 * resourcesLost;

        if (ready) {
          data.eventName = "raid";
          data.units = troops.reduce((units, { id, count }) => {
            units[id] = count;
            return units;
          }, {});
        }

        data.forecast = {
          for: "raid",
          ready,
          time: time * 3.6e6,
          result,
          alive,
          bounty: bountySum,
          xp,
          loot,
          bountyTime,
          resourcesLost,
          xpTime,
          ratio: Math.trunc(
            resourcesLost ? (bountySum / ((resourcesLost / 100) * time) + bountyTime * 0.3) / 100 : bountyTime / 100
          ),
        };
      }
    }

    const { scout } = this.unitsData;

    if (!data.eventName && !scouted && isOldReport && lootSum < 4000 && idleUnits[scout.id]) {
      data.eventName = "scout";
      data.units[this.unitsData.scout.id] = 1;
    }

    raidUnits[kid] = data;
    return data;
  };
}
