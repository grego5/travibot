import { getDistance, xy2id } from "./index.js";

export default class TileGetter {
  constructor({ api, storage }) {
    api.addRoutes([
      {
        name: "tileDetails",
        path: "/api/v1/map/tile-details",
        methods: ["POST"],
      },
    ]);

    this.api = api;
    this.storage = storage;
    this.animals = storage.get("tribes")[4];
    this.unitList = storage.get("tribes")[0];
    this.tileList = storage.get("tileList");
    this.reports = storage.get("reports");
    this.raidIncome = storage.get("raidIncome") || {
      amount: 0,
      since: Math.floor(Date.now() / 1000) * 1000,
    };
    this.updateQueue = new Map();
  }

  parseTile = (data) => {
    const { mapCell, mapReports, surroundingReports } = data;
    const now = Math.floor(Date.now() / 1000) * 1000;

    // types
    // 1 - village
    // 2 - valley
    // 3 - unoccupied oasis
    // 4 - occupied oasis
    // 5 - wilderness

    const { type, id: kid, oasis, x, y } = mapCell;
    const owned = [, true, false, false, true, false][type];

    const tile = this.tileList[kid] || {
      kid,
      timestamp: now,
      coords: { x, y },
      guards: {},
      defense: { idef: 0, cdef: 0, reward: 0, ratio: 0 },
    };

    tile.type = type;
    tile.owned = owned;

    const report = this.reports[kid] || { event: 0, timestamp: 0, loot: 0, scoutDate: 0 };

    if (type === 3) {
      const { troops } = oasis;

      const guards = {};
      const defense = { idef: 0, cdef: 0, reward: 0, ratio: 0 };

      for (const id in troops) {
        if (troops[id]) {
          const { idef, cdef, reward } = this.animals[id];
          const count = troops[id];
          guards[id] = count;
          defense.idef += idef * count;
          defense.cdef += cdef * count;
          defense.reward += reward * count;
        }
      }

      if (defense.reward) defense.ratio = Math.floor((defense.reward / Math.min(defense.idef, defense.cdef)) * 100);

      tile.guards = guards;
      tile.defense = defense;

      if (!tile.bonus) {
        let totalBonus = 0;
        tile.bonus = oasis.bonus.map(function ({ amount, resourceType }) {
          const { id } = resourceType;
          totalBonus += amount;
          return { id: [, "r1", "r2", "r3", "r4"][id], amount };
        });
        tile.production = { 25: 71, 50: 111 }[totalBonus];
      }

      const currentReport = mapReports?.reports[0];
      const currentRaid = surroundingReports?.reports[0];

      const reportDate = currentReport ? currentReport.time * 1000 : 0;
      const raidDate = currentRaid ? currentRaid.time * 1000 : 0;

      if (reportDate > report.timestamp || raidDate > report.timestamp) {
        if (reportDate >= raidDate) {
          const {
            icon,
            id,
            ownerId,
            scoutedResources,
            attackerTroop,
            attackerBooty: { resources, carryMax = 0 } = {},
          } = currentReport;
          const goods = resources ? Object.values(resources).reduce((acc, val) => (acc += val), 0) : 0;
          const loot = scoutedResources
            ? Object.values(scoutedResources).reduce((acc, val) => (acc += val), 0)
            : goods === carryMax
            ? Math.max(0, report.loot - carryMax)
            : 0;

          this.raidIncome.amount += goods;
          this.storage.set("raidIncome", this.raidIncome);

          scoutedResources && (report.scoutDate = reportDate);

          report.event = icon;
          report.id = id;
          report.timestamp = reportDate;
          report.loot = loot;
          report.ownerId = ownerId;
          report.lost = {};

          if (attackerTroop) {
            const { casualties } = attackerTroop;
            let total = 0;
            this.unitList.forEach((id) => {
              if (casualties[id]) {
                report.lost[id] = casualties[id];
                total++;
              }
            });
            if (total) report.event = 2;
          }
        } else if (raidDate > reportDate) {
          report.event = 3;
          report.player = currentRaid.activePlayer;
          report.timestamp = raidDate;
          report.loot = 0;
        }
      }

      if (report.timestamp) {
        const { production } = tile;
        report.loot += Math.round(((now - Math.max(report.timestamp, tile.timestamp)) / 3.6e6) * production); // produced since last refresh
      }
    }

    tile.timestamp = now;
    return { tile, report };
  };

  getTile = async ({ x, y }) => {
    const variables = { x, y };
    const query = `query($x:Int!,$y:Int!){mapCell(coordinates:{x:$x,y:$y}){type id x y oasis{bonus{resourceType{id}amount}troops{t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11}}}mapReports(coordinates:{x:$x,y:$y}){reports:mapCellReports{id time title icon ownerId scoutedResources{lumber clay iron crop}attackerBooty{carryMax resources{lumber clay iron crop}}attackerTroop{casualties{t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11}}}}surroundingReports:mapReports(coordinates:{x:$x,y:$y}){reports:surroundingReports{id time type activePlayer{id,name}}}}`;

    try {
      const data = await this.api.graphql({ query, variables, logEvent: `get tile ${x} | ${y}` });
      return this.parseTile(data);
    } catch (error) {
      console.log(error.message);
      return null;
    }
  };

  updateTiles = async () => {
    let query = "";
    let kidList = "[";

    for (const kid of this.updateQueue.keys()) {
      const { x, y } = this.updateQueue.get(kid).coords;
      kidList += kid + ", ";

      query += `m${kid}:mapCell(coordinates:{x:${x},y:${y}}){type id x y oasis{bonus{resourceType{id}amount}troops{t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11}}}r${kid}:mapReports(coordinates:{x:${x},y:${y}}){reports:mapCellReports{id time title icon ownerId scoutedResources{lumber clay iron crop}attackerBooty{carryMax resources{lumber clay iron crop}}attackerTroop{casualties{t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11}}}}s${kid}:mapReports(coordinates:{x:${x},y:${y}}){reports:surroundingReports{id time type activePlayer{id,name}}}`;
    }

    query = "query {" + query + "}";
    kidList = kidList.slice(0, -2) + "]";
    const tileUpdates = [];

    try {
      const res = await this.api.graphql({ query, logEvent: `update ${this.updateQueue.size} tiles ${kidList}` });

      for (const kid of this.updateQueue.keys()) {
        const { callback } = this.updateQueue.get(kid);
        const { report, tile } = this.parseTile({
          mapCell: res[`m${kid}`],
          mapReports: res[`r${kid}`],
          surroundingReports: res[`s${kid}`],
        });

        const cbdata = callback ? callback({ tile, report }) : null;

        tileUpdates.push({ report, tile, kid, cbdata });
      }
      this.updateQueue.clear();
      return tileUpdates;
    } catch (error) {
      console.log(error.message);
      console.log(this.updateQueue);
    }

    return tileUpdates;
  };

  getMapBlock = async (x, y) => {
    const blockSize = 9;
    const req = {
      query:
        "query ($xMin: Int!, $yMin: Int!, $xMax: Int!, $yMax: Int!) { mapBlock(xMin: $xMin, yMin: $yMin, xMax: $xMax, yMax: $yMax) {oases{conquered x y bonus{resourceType{id}amount}troops{t1 t2 t3 t4 t5 t6 t7 t8 t9 t10}}}}",
      variables: {
        xMin: x,
        yMin: y,
        xMax: x + blockSize,
        yMax: y + blockSize,
      },
    };

    return this.api.graphql(req);
  };

  explore = async (x, y, maxDistance = 14) => {
    const blockSize = 11;
    const blocks = Math.ceil(maxDistance / blockSize);
    const radius = blocks * blockSize;
    const targets = [];
    const tileUpdates = [];
    const offset = blocks > 1 ? radius + blocks - 1 : Math.floor(blockSize / 2);

    for (let xMin = x - offset; xMin < x + offset + blocks; xMin += blockSize + 1) {
      for (let yMin = y - offset; yMin < y + offset + blocks; yMin += blockSize + 1) {
        const data = await this.getMapBlock(xMin, yMin);
        const { oases } = data.mapBlock;
        oases.forEach((oasis) => {
          const distance = Math.round(getDistance({ x, y }, oasis) * 10) / 10;
          if (distance <= maxDistance) {
            const kid = xy2id(oasis);
            const type = "conquered" in oasis ? 4 : 3;
            const { x, y, troops, bonus } = oasis;
            const { tile, report } = this.parseTile({ mapCell: { type, id: kid, x, y, oasis: { troops, bonus } } });
            tileUpdates.push({ kid, tile, report });
            targets.push({ kid, distance, coords: { x, y } });
          }
        });
      }
    }

    targets.sort((a, b) => a.distance - b.distance);
    return { tileUpdates, targets };
  };
}

/*
  query ($x: Int!, $y: Int!) {
     mapCell(coordinates: { x: $x, y: $y }) {
       type, id, x, y,
       oasis {
         id,
         bonus { resourceType { id } amount },
         type, 
         troops { t1, t2, t3, t4, t5, t6, t7, t8, t9, t10 }
       },
     }
 
     mapReports(coordinates: { x: $x, y: $y }) {
       reports: mapCellReports { 
         id, time, title, icon, ownerId,
         scoutedResources { lumber, clay, iron, crop },
         attackerBooty {
           carryMax, 
           resources {
             lumber, clay, iron, crop
           }
         }
         attackerTroop {
          casualties { t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11 }
         }
       }
     }
 
     surroundingReports: mapReports(coordinates: { x: $x, y: $y }) {
       reports: surroundingReports { id, time, type }
     }
   }
 

m${kid} :mapCell(coordinates: { x: ${x}, y: ${y} }) {
    type, id, x, y
    oasis {
      id,
      bonus { resourceType { id } amount },
      type, 
      troops { t1, t2, t3, t4, t5, t6, t7, t8, t9 ,t10 }
    },
  }

  r${kid}: mapReports(coordinates: { x: ${x}, y: ${y} }) {
    reports: mapCellReports { 
      id, time, title, icon, ownerId
      scoutedResources { lumber, clay, iron, crop },
      attackerBooty { 
        carryMax, 
        resources {
          lumber, clay, iron, crop
        }
      }
      attackerTroop {
      casualties { t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11 }
      }
    }
  }

  s${kid}: mapReports(coordinates: { x: ${x}, y: ${y} }) {
    reports: surroundingReports { id, time, type }
  }
     

*/
