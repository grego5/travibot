export { default as main } from "./main.js";
export { default as FarmList } from "./FarmList.js";
export { default as HttpClient } from "./HttpClient.js";
export { default as mapExplorer } from "./mapExplorer.js";
export { default as Raid } from "./Raid.js";
export { default as RallyManager } from "./RallyManager.js";
export { default as Storage } from "./Storage.js";
export { default as TileGetter } from "./TileGetter.js";
export { default as TroopSetup } from "./TroopSetup.js";
export { default as WebSocketServer } from "./WebSocketServer.js";

export function xy2id({ x, y }) {
  const s = 401;
  const r = (s - 1) / 2;
  return (r - y) * s + (x - -r) + 1;
}

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

export const fragments = {
  tribes: `
    bootstrapData { 
      tribes {
        id, units {
          id, carry, attackPower, upkeepCost, velocity, defencePowerAgainstInfantry, defencePowerAgainstCavalry,
          trainingCost {
            lumber, clay, iron, crop
          }
        }
      }
    }
  `,
  rallypoint: `
    ownPlayer {
      village { 
        researchedUnits {
          id level
        } 
      }
    }
  `,
  hero: `
    ownPlayer {
      hero {
        attributes {
          code, value, usedPoints
        }
        xpPercentAchievedForNextLevel,
        xpForNextLevel,
        health,
        speed,
        level,
        homeVillage { id },
        isAlive,
        inventory {
          name, typeId, id, amount
        }
        equipment {
          rightHand {
            typeId
            attributes {
              effectType value
            }
          }
          leftHand {
            typeId
            attributes {
              effectType value
            }
          }
          helmet {
            typeId
            attributes {
              effectType value
            }
          }
          body{
            typeId
            attributes {
              effectType value
            }
          }
          shoes {
            typeId
            attributes {
              effectType value
            }
          }
          horse {
            id
            typeId
            attributes {
              effectType value
            }
          }
        }
      }
    }
  `,
  troops: `
    ownPlayer {
      villages {
        id, name, x, y,
        resources {
          lumberProduction,
          clayProduction,
          ironProduction,
          netCropProduction,
          lumberStock, 
          clayStock, 
          ironStock, 
          cropStock, 
          maxStorageCapacity, 
          maxCropStorageCapacity
        }
        ownTroops {
          units {
            t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11
          }
        }
        troops {
         moving  {
           edges {
             node {
               id,
               time,
               player { name id },
               scoutingTarget,
               units {
                 t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11
               }
               troopEvent {
                 cellFrom { id, x, y, village { name } },
                 cellTo { id, x, y, village { name } },
                 type,
                 arrivalTime
               }
             }
           }
         }
          ownTroopsAtTown {
            units {
              t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11
            }
          }
        }
      }
    }
  `,
};

export const unitLabels = {
  1: [
    "Legionnaire",
    "Praetorian",
    "Imperian",
    "Equites Legati",
    "Equites Imperatoris",
    "Equites Caesaris",
    "Battering ram",
    "Fire Catapult",
    "Senator",
    "Settler",
  ],
  2: [
    "Clubswinger",
    "Spearman",
    "Axeman",
    "Scout",
    "Paladin",
    "Teutonic Knight",
    "Ram",
    "Catapult",
    "Chief Settler",
    "Settler",
  ],
  3: [
    "Phalanx",
    "Swordsman",
    "Pathfinder",
    "Theutates Thunder",
    "Druidrider",
    "Haeduan",
    "Ram",
    "Trebuchet",
    "Chieftain",
    "Settler",
  ],
  4: ["Rat", "Spider", "Snake", "Bat", "Wild Boar", "Wolf", "Bear", "Crocodile", "Tiger", "Elephant"],
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
