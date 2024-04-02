import unitLabels from "./unitLables.js";

export const simCombat = ({
  infantryPower = 0,
  cavaleryPower = 0,
  infantryDefense = 0,
  cavaleryDefense = 0,
  attacker,
  defender,
}) => {
  const infantryRatio = infantryPower / (infantryPower + cavaleryPower);
  const cavaleryRatio = 1 - infantryRatio;
  const defense = infantryRatio * infantryDefense + cavaleryRatio * cavaleryDefense + 10;
  const power = infantryPower + cavaleryPower;
  const x = 100 * Math.pow(defense / power, 1.5);
  const loss = (100 * x) / (100 + x);
  const damage = (100 - loss) / 100;
  let resourcesLost = 0;

  const result = attacker.reduce((result, unit) => {
    const { id, count, cost = 0 } = unit;
    const lost = id === "t11" ? loss : Math.round(count * (loss / 100));
    const left = count - lost;
    resourcesLost += cost * lost;
    result.push({ ...unit, count: lost, left });
    return result;
  }, []);

  const { alive, bounty, xp } = defender.reduce(
    ({ alive, bounty, xp }, unit) => {
      const { upkeep, count } = unit;
      const kills = Math.round(count * damage);
      const left = count - kills;
      xp += kills * upkeep;
      bounty += kills * upkeep * 160;
      left && alive.push({ ...unit, count: left });

      return { alive, bounty, xp };
    },
    { alive: [], bounty: 0, xp: 0 }
  );
  return {
    result,
    alive,
    bounty,
    xp,
    resourcesLost,
    damage,
  };
};

export function parseTribesData(tribes) {
  const tribesData = {};
  tribes.forEach(function ({ id: tid, units }) {
    if (!(tid in unitLabels)) return;
    tribesData[tid] = {};
    units.forEach(function (unitStats, i) {
      const {
        id,
        carry,
        attackPower: attack,
        upkeepCost: upkeep,
        velocity: speed,
        defencePowerAgainstInfantry: idef,
        defencePowerAgainstCavalry: cdef,
        trainingCost,
      } = unitStats;
      const name = tid !== 4 && i === 9 ? "Settler" : unitLabels[tid][i];
      const icon = "u" + ((tid - 1) * 10 + i + 1);
      let cost = 0;
      for (const r in trainingCost) cost += trainingCost[r];

      tribesData[tid][id] = { name, icon, attack, idef, cdef, speed, upkeep, reward: upkeep * 160, carry, cost };
    });
    if (tid !== 4) {
      tribesData[tid]["t11"] = {
        name: "Hero",
        icon: "uhero",
      };
    }
  });

  return tribesData;
}

export function xy2id({ x, y }) {
  const s = 401;
  const r = (s - 1) / 2;
  return (r - y) * s + (x - -r) + 1;
}
