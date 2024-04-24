export { default as main } from "./main.js";
export { default as FarmList } from "./FarmList.js";
export { default as HttpClient } from "./HttpClient.js";
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
export function getDistance({ x: x1, y: y1 }, { x: x2, y: y2 }) {
  const deltaX = x2 - x1;
  const deltaY = y2 - y1;
  return Math.sqrt(deltaX ** 2 + deltaY ** 2);
}
export const fragments = {
  tribes: `bootstrapData{releaseVersion tribes{id,units{id,carry,attackPower,upkeepCost,velocity,defencePowerAgainstInfantry,defencePowerAgainstCavalry,trainingCost{lumber,clay,iron,crop}}}}`,
  rallypoint: `ownPlayer{village{researchedUnits{id level}}}`,
  resources: `ownPlayer{villages{id name x y resources{lumberProduction clayProduction ironProduction netCropProduction lumberStock clayStock ironStock cropStock maxStorageCapacity maxCropStorageCapacity}}}`,
  hero: `ownPlayer{hero{attributes{code value usedPoints}xpPercentAchievedForNextLevel xpForNextLevel health speed level homeVillage{id}isAlive inventory{name typeId id amount}equipment{rightHand{typeId attributes{effectType value}}leftHand{typeId attributes{effectType value}}helmet{typeId attributes{effectType value}}body{typeId attributes{effectType value}}shoes{typeId attributes{effectType value}}horse{id typeId attributes{effectType value}}}}}`,
  troops: `ownPlayer{villages{id name x y troops{moving{edges{node{id consumption time attackPower units{t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11}player{id name}troopEvent{cellFrom{id x y village{name}}cellTo{id x y village{id name}}type arrivalTime}}}}ownTroopsAtTown{units{t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11}}}}}`,
  build: (frags) =>
    frags.reduce((query, name) => {
      query += fragments[name];
      return query;
    }, "query{") + "}",
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
  const tribesData = [["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11"]];
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

      tribesData[tid][id] = { id, name, icon, attack, idef, cdef, speed, upkeep, reward: upkeep * 160, carry, cost };
      const scoutId = [, "t4", "t4", "t3"][tid];
      tribesData[tid].scout = tribesData[tid][scoutId];
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

export const logMessage = (text) => {
  console.log(
    `[${new Date().toLocaleTimeString("en-GB", {
      hour12: false,
    })}] ${text}`
  );
};
