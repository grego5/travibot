import { JSDOM } from "jsdom";

export default class TileGetter {
  constructor({ api, browser, storage, tribes }) {
    api.addRoutes([
      {
        name: "tileDetails",
        path: "/api/v1/map/tile-details",
        methods: ["POST"],
      },
    ]);

    this.api = api;
    this.browser = browser;
    this.storage = storage;
    this.animals = tribes[4];
    this.tileList = storage.get("tileList");
    this.reports = storage.get("reports");
    this.raidIncome = storage.get("raidIncome") || {
      amount: 0,
      since: Date.now(),
    };
    this.updateQueue = new Map();
  }

  getdoc = async (x, y) => {
    try {
      const res = await this.api.tileDetails.post({
        referrer: `/karte.php?x=-${x}&y=${y}`,
        body: { x, y },
        method: "POST",
      });

      const { html } = await res.json();
      const dom = new JSDOM(html);
      return dom.window.document;
    } catch (error) {
      console.log(error.message);
    }
  };

  parseTile = (data) => {
    const { mapCell, mapReports, surroundingReports, callback } = data;
    const now = Date.now();
    /*
        type
        1 - village
        2 - valley
        3 - unoccupied oasis
        4 - occupied oasis
        5 - wilderness
    
      */

    const { type, id: kid, oasis, x, y } = mapCell;
    const owned = [, true, false, false, true, false][type];

    const tile = this.tileList[kid] || {
      kid,
      timestamp: now,
      coords: { x, y },
      type,
      owned,
    };

    tile.type !== type && Object.assign(tile, { type, owned });

    const report = this.reports[kid] || {
      icon: "",
      text: "No data",
      url: `https://${this.api.hostname}/karte.php?x=${x}&y=${y}`,
      timestamp: now,
      loot: 0,
      scoutDate: 0,
    };

    if (type === 3) {
      const { troops } = oasis;

      const guards = [];
      const defense = {
        idef: 0,
        cdef: 0,
        reward: 0,
        ratio: 0,
      };

      for (const id in troops) {
        if (troops[id]) {
          const { name, icon, idef, cdef, reward, upkeep } = this.animals[id];
          const count = troops[id];

          guards.push({
            id,
            icon,
            name,
            count,
            upkeep,
          });

          defense.idef += idef * count;
          defense.cdef += cdef * count;
          defense.reward += reward * count;
        }
      }

      if (guards.length) defense.ratio = Math.floor((defense.reward / Math.min(defense.idef, defense.cdef)) * 100);

      if (!tile.bonus) {
        let totalBonus = 0;
        tile.bonus = oasis.bonus.map(function ({ amount, resourceType }) {
          const { id } = resourceType;
          totalBonus += amount;
          return {
            name: [, "Lumber", "Clay", "Iron", "Food"][id],
            icon: [, "r1", "r2", "r3", "r4"][id],
            amount,
          };
        });
        tile.production = { 25: 71, 50: 111 }[totalBonus];
      }

      Object.assign(tile, {
        owned,
        guards,
        defense,
      });

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
            title,
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

          const casualties = attackerTroop ? attackerTroop.casualties : {};

          Object.assign(report, {
            icon: "iReport" + icon,
            text: title,
            title,
            url: `https://${this.api.hostname}/report?id=${id}`,
            timestamp: reportDate,
            loot,
            ownerId,
            casualties,
          });
        } else if (raidDate > reportDate) {
          Object.assign(report, {
            icon: "iReport3",
            title: "The oasis has been plundered",
            text: "The oasis has been plundered",
            timestamp: raidDate,
            loot: 0,
          });
        }
      }

      if (!mapReports) {
        report.icon = "iReport23";
        report.loot = -1;
      } else {
        const { production } = tile;
        report.loot += Math.round(((now - Math.max(report.timestamp, tile.timestamp)) / 3.6e6) * production); // produced since last refresh
      }
    }

    tile.timestamp = now;
    callback && callback({ tile, report });
    return { tile, report };
  };

  getTile = async ({ x, y }) => {
    const variables = { x, y };

    const query = `
   query ($x: Int!, $y: Int!) {
     mapCell(coordinates: { x: $x, y: $y }) {
       type, id, x, y,
       oasis {
         id,
         bonus { resourceType { id } amount },
         type, 
         bonusResources, 
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
 `;
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

      query += `
     m${kid} :mapCell(coordinates: { x: ${x}, y: ${y} }) {
         type, id, x, y
         oasis {
           id,
           bonus { resourceType { id } amount },
           type, 
           bonusResources, 
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
     `;
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
          callback,
        });

        tileUpdates.push({ report, tile, kid });
      }
      this.updateQueue.clear();
      return tileUpdates;
    } catch (error) {
      console.log(error.message);
      console.log(this.updateQueue);
    }

    return tileUpdates;
  };

  getTileCard = async ({ x, y, did }, data = null) => {
    const doc = data || (await this.getdoc(x, y).then((doc) => doc.querySelector("#tileDetails")));
    const timestamp = Date.now();

    const kidMatch = doc.querySelector(".detailImage").innerHTML.match(/MapId=(\d+)/);
    const kid = kidMatch ? +kidMatch[1] : null;
    const link = doc.querySelector(".option").children[0].href;
    const coords = {
      x: x || +link.match(/x=([-+]?\d+)/)[1],
      y: y || +link.match(/y=([-+]?\d+)/)[1],
    };
    /*
     type
     1 - village
     2 - valley
     3 - unoccupied oasis
     4 - occupied oasis
     5 - wilderness
   */
    const owned = doc.querySelector("#village_info") ? true : false;
    const type = { village: owned ? 1 : 2, oasis: owned ? 4 : 3, landscape: 5 }[doc.classList[0]];

    const distance = (() => {
      if (type === 3 || type === 4)
        return +doc.querySelector("#distance").querySelectorAll("td")[1].textContent.split(" ")[0];
      if (type === 1) return +doc.querySelector("#village_info").querySelectorAll("td")[4].textContent.split(" ")[0];
      if (type === 2) return +doc.querySelector(".bold").textContent.split(" ")[0];
      if (type === 5) return 0;
    })();

    const tile = {
      kid,
      timestamp,
      coords,
      type,
      owned,
      distance,
    };

    if (type === 3) {
      const guards = [];
      const defense = {
        idef: 0,
        cdef: 0,
        reward: 0,
        upkeep: 0,
        ratio: 0,
      };
      const troop_info = [...doc.querySelector("#troop_info").rows].slice(0, -1);

      if (troop_info[0].textContent !== "none") {
        for (const unit of troop_info) {
          const id = "t" + (+unit.querySelector(".unit").classList[1].slice(1) - 30);
          const count = +unit.children[1].textContent;
          const { name, icon, idef, cdef, reward, upkeep } = this.animals[id];

          guards.push({
            id,
            icon,
            name,
            count,
            upkeep,
          });

          defense.idef += idef * count;
          defense.cdef += cdef * count;
          defense.reward += reward * count;
        }
        defense.ratio = Math.floor((defense.reward / Math.min(defense.idef, defense.cdef)) * 100);
      }

      const bonus = [];

      const totalBonus = [...doc.querySelector("#distribution").rows].reduce(function (acc, res) {
        const amount = +res.textContent.match(/\d+/)[0];
        bonus.push({
          icon: res.children[0].children[0].className,
          amount,
          name: res.children[2].textContent,
        });

        return (acc += amount);
      }, 0);

      const production = { 25: 71, 50: 111 }[totalBonus];

      Object.assign(tile, {
        guards,
        defense,
        bonus,
        production,
      });
    }

    tile.save = () => {
      delete tile.distance;
      if (kid in this.tileList) {
        const { villages } = this.tileList[kid];
        villages.find((v) => Number(v.did) === Number(did)) === -1 && villages.push({ did, distance });
        Object.assign(tileList[kid], tile);
      } else this.tileList[kid] = Object.assign(tile, { villages: [{ did, distance }] });
      this.storage.set("tileList", this.tileList);
      return tile;
    };

    return tile;
  };
}
