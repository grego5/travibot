import { fragments } from "./index.js";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function main(data) {
  const {
    storage,
    ownId,
    farmList,
    rallyManager,
    tileGetter,
    villageTroops,
    goldClub,
    nextStageDate,
    unitsData,
    wss,
    api,
  } = data;
  const { map, rallyCron, tileList, reports, raidList } = storage.getAll();
  const { createRally } = rallyManager;
  const { updateTiles, updateQueue } = tileGetter;

  let asyncStatus = 0;
  const rallyQueue = new Map();
  let heroTarget = null;
  let lastTileUpdate = 0;
  let lastStatusUpdate = Date.now();
  const statusQuery = `query {
    ${fragments.hero + fragments.troops}
  }`;

  const reassignTroops = (villages) => {
    const reassigned = villages.map((did) => {
      const { targets } = map[did];
      const troopsData = villageTroops.get(did);
      const { assign: assignTroops } = troopsData;

      targets.forEach(({ kid, distance }) => {
        if (tileList[kid].owned) return;

        assignTroops({ kid, distance });
      });

      return { did, troopsData };
    });
    return reassigned;
  };

  const queueTile = ({ kid, coords, force }) => {
    if (force) lastTileUpdate = 0;
    updateQueue.set(kid, {
      coords: coords || tileList[kid].coords,
      callback({ tile, report }) {
        console.log("old tile update " + kid);
        tileList[kid] = tile;
        reports[kid] = report;
        storage.save();

        const { villages = [], owned } = tile;

        !owned &&
          villages.forEach(({ did, distance }) => {
            villageTroops.get(did).assign({ kid, distance });
          });
      },
    });
  };

  wss.setRoute("sendTroops", (data) => {
    if (data.eventName === "hero") {
      const { did, kid, coords } = data;
      heroTarget = { kid, did, coords, ratio: 999, delay: 0 };
    } else {
      const { kid, listId, targetId } = data;
      const rally = createRally(data);
      rallyQueue.set(kid, { id: targetId, listId, rally });
    }
  });
  wss.setRoute("updateTile", ({ kid, coords }) => queueTile({ kid, coords, force: 1 }));

  setInterval(async () => {
    const now = Date.now();

    // status updates
    if (now - lastStatusUpdate > 3e5) {
      const data = await api.graphql({ query: statusQuery, logEvent: "status update" });
      const { hero, villages } = data.ownPlayer;
      villageTroops.update({ hero, villages });
      fs.writeFileSync(__dirname + "/logs/villageTroops.json", JSON.stringify(villageTroops, null, 2), "utf8");
      lastStatusUpdate = now;
    }

    // scheduled raids
    for (const next of rallyCron) {
      if (next.departure - now > 1000) break;

      const { did, troops } = next;
      const { idleTroops, hero } = villageTroops.get(did);

      troops.forEach((unit) => {
        const available = Math.min(unit.count, idleTroops[unit.id]);
        unit.count = available;
        idleTroops[unit.id] -= available;
        if (unit.id === "t11") next.hero = hero;
      });

      createRally(rallyCron.shift()).dispatch();
      storage.save();
    }

    // cleanup expired raids
    for (const i in raidList) {
      const kid = Number(i);
      const activeRaids = raidList[kid].filter(({ origin, type, returnDate, troops }) => {
        if (type === 9 && returnDate < now - 1000) {
          console.log(
            "raid return " +
              troops.reduce((acc, { id, count }) => {
                acc += `${id}:${count} `;
                return acc;
              }, "")
          );
          const { idleTroops } = villageTroops.get(origin);
          troops.forEach(({ id, count }) => (idleTroops[id] += count));
          const reassigned = reassignTroops([origin]);
          wss.send([{ event: "villageTroops", payload: reassigned }]);
          return false;
        } else return true;
      });

      if (activeRaids.length < raidList[kid].length) {
        if (!activeRaids.length) {
          delete raidList[kid];
        } else raidList[kid] = activeRaids;

        storage.save();
      }

      if (asyncStatus) return;

      const currentRaid = activeRaids[0];

      // check and update status of the current raid

      if (currentRaid && currentRaid.arrivalDate <= now && currentRaid.type !== 9) {
        const { coords } = currentRaid;

        lastTileUpdate = 0;
        updateQueue.set(kid, {
          coords,
          callback({ tile, report }) {
            console.log("raid arrival " + kid);
            const raids = raidList[kid];
            const currentRaid = raids[0];

            const { villages = [], owned } = tile;

            !owned &&
              villages.forEach(({ did, distance }) => {
                villageTroops.get(did).assign({ kid, distance });
              });

            if (report.ownerId === ownId) {
              const { casualties } = report;
              currentRaid.troops = currentRaid.troops.filter((unit) => {
                unit.count -= casualties[unit.id] || 0;
                return unit.count;
              });
              if (!currentRaid.troops.length) currentRaid.returnDate = 0; // dead
            }
            currentRaid.type = 9;

            raids.sort((a, b) => {
              const dateA = a.type === 9 ? a.returnDate : a.arrivalDate;
              const dateB = b.type === 9 ? b.returnDate : b.arrivalDate;
              return dateA - dateB;
            });

            if (kid in tileList) {
              tileList[kid] = tile;
              reports[kid] = report;
            }
            storage.save();
          },
        });
        continue;
      }
    }

    // queue updates and raids
    for (const i in map) {
      const did = Number(i);
      const { listId, targets, autoraid } = map[did];
      const { totalTroops, idleTroops, raidTroops, assign: assignTroops } = villageTroops.get(did);
      let raidTarget = null;

      for (const { coords, distance, kid, id: targetId } of targets) {
        const tile = tileList[kid];
        const report = reports[kid] || { scoutDate: 0, timestamp: now, loot: 0 };

        if (!raidTroops[kid]) assignTroops({ kid, distance });

        if (tile.type === 4) {
          // check occupied oasises every 7 days
          if (now - tile.timestamp > 6.048e8) {
            updateQueue.set(kid, {
              coords,
              callback({ tile }) {
                console.log("ownership change " + kid);
                if (!tile.owned) {
                  farmList.createSlots({ listId, targets: [{ coords, kid }] });
                }
              },
            });
          }
          continue;
        }

        const raids = raidList[kid];
        const raidsCount = raids ? raids.filter((raid) => raid.arrivalDate > now).length : 0;
        const isBeginer = nextStageDate > now && (tile.bonus[0].icon !== "r4" || totalTroops.t1 > 40);
        const isAdvanced = nextStageDate < now;

        if (isBeginer) {
          if (idleTroops.t1 >= 2 && distance <= 9) {
            if (now - tile.timestamp > 3e5) queueTile({ kid });

            if (updateQueue.size || !autoraid || rallyQueue.has(kid)) continue;

            const { production, defense } = tile;
            const produce = (distance / unitsData.t1.speed) * production;
            const hasLoot = report.loot + produce - raidsCount * 100 > 50;
            const needWait = raids && now - raids[raids.length - 1].departDate < 6e5; // 10 min delay

            if (hasLoot && !needWait && !tile.owned && !defense.reward) {
              rallyQueue.set(kid, {
                id: targetId,
                listId,
                rally: createRally({ did, eventName: "raid", coords, units: { t1: 2 } }),
              });
            }
          }
        }

        if (isAdvanced && !raidsCount) {
          const isOldTile = now - tile.timestamp > Math.round(Math.max(1, distance / 2 - 2.5) * 6.0e5);
          isOldTile && !updateQueue.has(kid) && queueTile({ kid });

          if (updateQueue.size || !autoraid || rallyQueue.has(kid)) continue;

          const { eventName, troops, forecast } = raidTroops[kid];

          if (eventName) {
            const { ratio } = forecast;

            switch (eventName) {
              case "raid":
                if (!raidTarget || raidTarget.ratio < ratio) raidTarget = { kid, did, ratio, coords, targetId };
                break;
              case "hero":
                if (!heroTarget || heroTarget.ratio < ratio) heroTarget = { kid, did, ratio, coords, delay: 20000 };
                break;
              default:
                rallyQueue.set(kid, {
                  id: targetId,
                  listId,
                  rally: createRally({ did, eventName, coords, troops: [...troops] }),
                });
            }
          }
        }
      }

      if (raidTarget) {
        const { kid, did, targetId, coords } = raidTarget;
        const { eventName, troops } = raidTroops[kid];

        rallyQueue.set(kid, {
          id: targetId,
          listId,
          rally: createRally({ did, eventName, coords, troops: [...troops] }),
        });
      }
    }

    // update tiles
    if (updateQueue.size && (now - lastTileUpdate >= 6e4 || updateQueue.size >= 10)) {
      asyncStatus++;
      const updates = await updateTiles();
      wss.send({ event: "tileList", payload: updates });
      lastTileUpdate = Date.now();
      asyncStatus--;
    }

    // dispatch hero
    if (heroTarget) {
      asyncStatus++;
      const { did, kid, coords, delay } = heroTarget;
      const { idleTroops, raidTroops, hero } = villageTroops.get(did);
      const { eventName, troops } = raidTroops[kid];
      const rally = createRally({ did, eventName, coords, troops, hero });
      console.log(`Hero will be sent to ${rally.coords.x} | ${rally.coords.y}`);

      setTimeout(async () => {
        if (idleTroops.t11 && (!delay || map[did].autoraid)) {
          idleTroops.t11 = 0;
          const raids = await rally.dispatch();
          const reassigned = reassignTroops([did]);
          raids &&
            wss.send([
              { event: "villageTroops", payload: reassigned },
              { event: "raidList", payload: [{ kid, raids }] },
            ]);
        }
        heroTarget = null;
        asyncStatus--;
      }, delay);
    }

    // dispatch raids
    if (rallyQueue.size) {
      asyncStatus++;
      if (goldClub) {
        const sortedQueue = await farmList.updateSlots({ rallyQueue, villageTroops });
        const { raidingVillages, raidedTiles } = await farmList.send({ rallyQueue, sortedQueue });

        const reassigned = reassignTroops(raidingVillages);
        wss.send([
          { event: "villageTroops", payload: reassigned },
          { event: "raidList", payload: raidedTiles },
        ]);
        rallyQueue.clear();
        asyncStatus--;
      } else {
        let delay = 0;
        const raidingVillages = [];
        const raidedTiles = [];

        for (const kid of rallyQueue.keys()) {
          raidedTiles.push(
            new Promise((resolve) => {
              const { rally } = rallyQueue.get(kid);
              const { did } = rally;

              setTimeout(async () => {
                const { idleTroops } = villageTroops.get(did);
                const check = rally.troops.every(({ id, count }) => idleTroops[id] >= count);

                if (check) {
                  rally.troops.forEach(({ id, count }) => (idleTroops[id] -= count));
                  if (!raidingVillages.find((id) => id === did)) raidingVillages.push(did);
                  const raids = await rally.dispatch();

                  raids ? resolve({ kid, raids }) : resolve(null);
                } else resolve(null);
              }, delay * 500);
            })
          );

          delay++;
        }

        const values = await Promise.all(raidedTiles).then((arr) => arr.filter((data) => data !== null));
        rallyQueue.clear();
        const reassigned = reassignTroops(raidingVillages);
        wss.send([
          { event: "villageTroops", payload: reassigned },
          { event: "raidList", payload: values },
        ]);
        asyncStatus--;
      }
    }
  }, 1000);
}

export default main;
