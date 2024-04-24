const t1 = "t1";
const t11 = "t11";

export default class TroopSetup {
  constructor({ storage, hero, villages, tribes, tribeId }) {
    this.unitsData = tribes[tribeId];
    this.combatSim = new CombatSimulator({ tribes, tribeId }).sim;
    this.map = storage.get("map");
    this.raidArrays = storage.get("raidArrays");
    this.tileList = storage.get("tileList");
    this.reports = storage.get("reports");
    this.hero = hero;
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

  assign = (did, { kid, distance }) => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    const data = {
      units: {},
      forecast: {},
      eventName: "",
    };

    try {
      const { defense, guards, owned } = this.tileList[kid];
      if (owned) return data;
      const autoraid = this.map[did].autosettings.raid;
      const { idleUnits, raidUnits, hero } = this.villages[did];
      const report = this.reports[kid];
      const { reward, idef, cdef } = defense;
      const raidArray = this.raidArrays[did];
      const isOldReport = now - report.timestamp >= 2.16e7; // 6 hours
      const scouted = report.scoutDate === report.timestamp && now - report.timestamp < 2.16e7;
      const lootSum = reward + report.loot;
      const sumToDistance = lootSum / distance;

      if (!reward && scouted && sumToDistance >= 100) {
        let id = null;
        let required = 0;

        for (let i = 1; i < 7; i++) {
          const unit = this.unitsData[id];
          const newId = "t" + String(i);
          const newUnit = this.unitsData[newId];
          const newRequired = Math.ceil(report.loot / newUnit.carry);
          const isAvaible = idleUnits[newId] * autoraid[newId] >= newRequired;
          const isFaster = newUnit.speed / distance >= 0.8 && (!id || newUnit.speed > unit.speed);

          if (isAvaible && isFaster) (id = newId), (required = newRequired);
        }

        if (id) {
          data.eventName = "loot";
          data.units[id] = Math.min(idleUnits[id], required);
        }
      }

      if (!data.eventName && hero) {
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
        const attacker = { t11: hero.health };

        const footCombat = this.combatSim({
          infantryPower: power,
          infantryDefense: idef,
          cavaleryDefense: cdef,
          attacker,
          defender: guards,
        });

        const mountCombat = this.combatSim({
          cavaleryPower: power,
          infantryDefense: idef,
          cavaleryDefense: cdef,
          attacker,
          defender: guards,
        });

        const mountedRaid =
          mountCombat.result.t11 <= heroBonus.damageReduction ||
          distance / 7 > 0.8 ||
          mountCombat.result.t11 - footCombat.result.t11 < 2;

        const speed = 7 + mountedRaid ? Math.max(7, heroBonus.mountSpeed) : 0;
        const { result, alive, bounty, xp: _xp } = mountedRaid ? mountCombat : footCombat;
        const time = distance / speed;
        const xp = Math.round(_xp * (1 + heroBonus.xp / 100));
        const minXpToLoss = Math.min((5 / 20) * hero.level, Math.round((hero.xpForNextLevel / hero.health) * 10) / 10);

        const healthLoss = Math.max(result.t11 - heroBonus.damageReduction, 0);
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
          ratio: Math.trunc(
            healthLoss > 2 ? (bounty / (percetLoss * time) + bountyTime * 0.4) / 100 : bountyTime / 100
          ),
        };

        if (ready && idleUnits.t11) {
          data.eventName = "hero";
          data.units.t11 = 1;
        }
      }

      if (!data.eventName && raidArray && report.loot > 1000) {
        let infantryPower = 0;
        let cavaleryPower = 0;
        let raidSpeed = 100;
        let raidCarry = 0;
        let totalUnits = 0;
        const units = {};

        for (const id in raidArray) {
          const count = Math.min(idleUnits[id] * autoraid[id], raidArray[id]);
          const { speed, attack, carry } = this.unitsData[id];

          if (id !== t11) {
            speed > 8 ? (cavaleryPower += attack * count) : (infantryPower += attack * count);
          }

          if (count >= raidArray[id] * 0.8 && (id === t11 ? hero.health >= 33 : true)) {
            units[id] = count;
            totalUnits += count;
            if (speed < raidSpeed) raidSpeed = speed;
            raidCarry += carry;
          } else {
            totalUnits = 0;
            break;
          }
        }

        if (totalUnits) {
          const res = this.combatSim({
            infantryPower,
            cavaleryPower,
            infantryDefense: idef,
            cavaleryDefense: cdef,
            attacker: units,
            defender: guards,
          });

          if (res.resourcesLost / 600 > 2) {
            const { speed, attack, carry } = this.unitsData[t1];
            const count = idleUnits[t1] >= 1000 ? Math.max(2000, idleUnits[t1]) : Math.ceil(2000 / attack);

            if (idleUnits[t1] >= count) {
              infantryPower += attack * count;
              units.t1 = count;
              if (speed < raidSpeed) raidSpeed = speed;
              raidCarry += carry;
            } else {
              totalUnits = 0;
            }
          }
        }

        if (totalUnits) {
          const { result, alive, bounty, xp, resourcesLost } = this.combatSim({
            infantryPower,
            cavaleryPower,
            infantryDefense: idef,
            cavaleryDefense: cdef,
            attacker: units,
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
            data.units = units;
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

      if (
        !data.eventName &&
        !scouted &&
        (isOldReport || report.event === 3) &&
        lootSum < 4000 &&
        idleUnits[scout.id] * autoraid[scout.id]
      ) {
        data.eventName = "scout";
        data.units[scout.id] = 1;
      }

      raidUnits[kid] = data;
    } catch (error) {
      console.error(error);
      console.log("kid: ", kid);
    }
    return data;
  };
}

class CombatSimulator {
  constructor({ tribes, tribeId }) {
    this.animals = tribes[4];
    this.unitsData = tribes[tribeId];
  }

  sim = ({ infantryPower = 0, cavaleryPower = 0, infantryDefense = 0, cavaleryDefense = 0, attacker, defender }) => {
    const infantryRatio = infantryPower / (infantryPower + cavaleryPower);
    const cavaleryRatio = 1 - infantryRatio;
    const defense = infantryRatio * infantryDefense + cavaleryRatio * cavaleryDefense + 10;
    const power = infantryPower + cavaleryPower;
    const x = 100 * Math.pow(defense / power, 1.5);
    const loss = (100 * x) / (100 + x);
    const damage = (100 - loss) / 100;
    let resourcesLost = 0;
    const result = {};
    const alive = {};
    let xp = 0;
    let bounty = 0;

    for (const id in attacker) {
      const { cost } = this.unitsData[id] || { cost: 0 };
      const lost = id === "t11" ? loss : Math.round(attacker[id] * (loss / 100));
      resourcesLost += cost * lost;
      result[id] = lost;
    }

    for (const id in defender) {
      const { upkeep } = this.animals[id];
      const kills = Math.round(defender[id] * damage);
      const left = defender[id] - kills;
      xp += kills * upkeep;
      bounty += kills * upkeep * 160;
      if (left) alive[id] = left;
    }

    return {
      result,
      alive,
      bounty,
      xp,
      resourcesLost,
      damage,
    };
  };
}
