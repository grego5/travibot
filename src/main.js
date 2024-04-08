import { fragments } from "./index.js";
// import fs from "fs";
// import { fileURLToPath } from "url";
// import path from "path";
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);
// fs.writeFileSync(__dirname + "/logs/villageTroops.json", JSON.stringify(villageTroops, null, 2), "utf8");

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
  const { createRally, raidingVillages, raidedTiles } = rallyManager;
  const { updateTiles, updateQueue } = tileGetter;

  let asyncStatus = 0;
  const rallyQueue = new Map();
  let heroTarget = null;
  let heroIdleSince = 0;
  let lastTileUpdate = 0;
  let lastStatusUpdate = Date.now();
  const statusQuery = `query {
    ${fragments.hero + fragments.troops}
  }`;

  const reassignTroops = (villages) => {
    const reassigned = {};
    villages.forEach((did) => {
      const { targets } = map[did];
      const troopsData = villageTroops.get(did);

      targets.forEach(({ kid, distance }) => {
        if (tileList[kid].owned) return;

        troopsData.assign({ kid, distance });
      });

      reassigned[did] = troopsData;
    });
    return reassigned;
  };

  const queueTile = ({ kid, coords }) => {
    updateQueue.set(kid, {
      coords,
      callback({ tile, report }) {
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
    if (data.eventName === "hero" || (data.units.length === 1 && data.units.t11)) {
      // Redundant check for data.units.length?
      const { did, kid, to } = data;
      heroIdleSince = 0;
      heroTarget = { kid, did, to, ratio: 999 };
    } else {
      const { kid, listId, targetId } = data;
      const rally = createRally(data);
      rallyQueue.set(kid, { id: targetId, listId, rally });
    }
  });
  wss.setRoute("updateTile", ({ kid, coords }) => {
    lastTileUpdate = 0;
    queueTile({ kid, coords });
  });
  wss.setRoute("raidAbort", ({ kid, recall }) => {
    const now = Date.now();
    const raid = raidList[kid].find((raid) => raid.recall === recall);
    raid.returnDate = now - raid.departDate + now;
    raid.arrivalDate = 0;
    raid.eventType = 9;
  });

  setInterval(async () => {
    const now = Date.now();

    // Status updates
    if (!asyncStatus && now - lastStatusUpdate > 3e5) {
      asyncStatus++;
      const data = await api.graphql({ query: statusQuery, logEvent: "status update" });
      const { hero, villages } = data.ownPlayer;
      const reassigned = villageTroops.update({ hero, villages });
      for (const did in reassigned) wss.send({ event: "villageTroops", payload: reassigned[did] });
      raidingVillages.length = 0;
      lastStatusUpdate = now;
      asyncStatus--;
    }

    // Reassign departed and arrived village troops. Update raidList
    if (!asyncStatus && raidedTiles.length) {
      const reassigned = reassignTroops(raidingVillages);
      wss.send({ event: "raidList", payload: raidedTiles });
      for (const did in reassigned) wss.send({ event: "villageTroops", payload: reassigned[did] });
      raidedTiles.length = 0;
      raidingVillages.length = 0;
    }

    // Scheduled raids
    if (rallyCron.length && rallyCron[0].departDate - now <= 999) {
      for (const next of rallyCron) {
        if (next.departDate - now >= 1000) break;

        const { did, troops } = next;
        const { idleTroops, hero } = villageTroops.get(did);

        const check = troops.every((unit) => {
          const { id, count } = unit;
          if (idleTroops[id] < Math.ceil(count * 0.9)) return false;
          const available = Math.min(count, idleTroops[id]);
          unit.count = available;
          if (id === "t11") {
            next.hero = hero;
            heroIdleSince = 0;
          }
          idleTroops[id] -= available;
          return true;
        });

        const props = rallyCron.shift();

        if (check) {
          asyncStatus++;
          await createRally(props).dispatch();
          asyncStatus--;
        } else {
          troops.forEach(({ id, count }) => (idleTroops[id] += count));
        }
      }
      storage.save();
    }

    // Cleanup expired raids. Skip if async. Update arrived raids.
    for (const i in raidList) {
      const kid = Number(i);
      const activeRaids = raidList[kid].filter(({ did, eventType, returnDate, troops, hero }) => {
        if (eventType === 9 && returnDate - now <= 999) {
          console.log(
            `[${new Date().toLocaleTimeString("en-GB", { hour12: false })}] raid return ` +
              troops.reduce((acc, { id, count }) => {
                acc += `${id}:${count} `;
                return acc;
              }, "")
          );

          if (troops.length) {
            const { idleTroops } = villageTroops.get(did);
            troops.forEach(({ id, count }) => (idleTroops[id] += count));
            raidingVillages.find((v) => v.did === did) || raidingVillages.push(did);
            if (hero) heroIdleSince = now;
          }
          return false;
        } else return true;
      });

      if (activeRaids.length < raidList[kid].length) {
        raidList[kid] = activeRaids;
        raidedTiles.push({ kid, raids: activeRaids });
        storage.save();
      }

      if (asyncStatus) return;

      const currentRaid = activeRaids[0];

      // Check and update status of the current raid
      if (currentRaid && currentRaid.arrivalDate - now <= 999 && currentRaid.eventType !== 9) {
        const { to } = currentRaid;

        lastTileUpdate = 0;
        updateQueue.set(kid, {
          coords: to,
          callback({ tile, report }) {
            if (kid in tileList) {
              tileList[kid] = tile;
              reports[kid] = report;
            }
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
            currentRaid.eventType = 9;

            raids.sort((a, b) => {
              const dateA = a.eventType === 9 ? a.returnDate : a.arrivalDate;
              const dateB = b.eventType === 9 ? b.returnDate : b.arrivalDate;
              return dateA - dateB;
            });

            storage.save();
          },
        });
        continue;
      }
    }

    // Queue updates and raids
    for (const i in map) {
      const did = Number(i);
      const { listId, targets, autoraid } = map[did];
      const { totalTroops, idleTroops, raidTroops, assign: assignTroops, name, coords } = villageTroops.get(did);
      const from = { x: coords.x, y: coords.y, name };
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

        const raids = raidList[kid] || (raidList[kid] = []);
        const raidsCount = raids.filter((raid) => raid.arrivalDate > now).length;
        const isBeginer = nextStageDate > now && (tile.bonus[0].icon !== "r4" || totalTroops.t1 > 40);
        const isAdvanced = nextStageDate < now;

        if (isBeginer) {
          if (idleTroops.t1 >= 2 && distance <= 9) {
            if (now - tile.timestamp > 3e5) queueTile({ kid, coords });

            if (updateQueue.size || !autoraid || rallyQueue.has(kid)) continue;

            const { production, defense } = tile;
            const produce = (distance / unitsData.t1.speed) * production;
            const hasLoot = report.loot + produce - raidsCount * 100 > 50;
            const needWait = raids && now - raids[raids.length - 1].departDate < 6e5; // 10 min delay

            if (hasLoot && !needWait && !tile.owned && !defense.reward) {
              rallyQueue.set(kid, {
                id: targetId,
                listId,
                rally: createRally({ did, from, eventName: "raid", to: coords, units: { t1: 2 } }),
              });
            }
          }
        }

        if (isAdvanced && !raidsCount) {
          const isOldTile = now - tile.timestamp > Math.round(Math.max(1, distance / 2 - 2.5) * 6.0e5);
          isOldTile && !updateQueue.has(kid) && queueTile({ kid, coords });

          if (updateQueue.size || !autoraid || rallyQueue.has(kid)) continue;

          const { eventName, troops, forecast } = raidTroops[kid];

          if (eventName) {
            const { ratio } = forecast;

            switch (eventName) {
              case "raid":
                if (!raidTarget || raidTarget.ratio < ratio) raidTarget = { kid, did, ratio, to: coords, targetId };
                break;
              case "hero":
                if (now - heroIdleSince > 20000 && (!heroTarget || heroTarget.ratio < ratio))
                  heroTarget = { kid, did, to: coords, ratio };
                break;
              default:
                rallyQueue.set(kid, {
                  id: targetId,
                  listId,
                  rally: createRally({ did, from, eventName, to: coords, troops }),
                });
            }
          }
        }
      }

      if (raidTarget) {
        const { kid, did, targetId, to } = raidTarget;
        const { eventName, troops, coords, name } = raidTroops[kid];

        rallyQueue.set(kid, {
          id: targetId,
          listId,
          rally: createRally({ did, from: { x: coords.x, y: coords.y, name }, to, eventName, troops }),
        });
      }
    }

    // Update tiles
    if (updateQueue.size && (now - lastTileUpdate >= 6e4 || updateQueue.size >= 10)) {
      asyncStatus++;
      const updates = await updateTiles();
      wss.send({ event: "tileList", payload: updates });
      const villages = villageTroops.get();
      for (const did in villages) wss.send({ event: "villageTroops", payload: villages[did] });
      raidingVillages.length = 0;
      lastTileUpdate = Date.now();
      asyncStatus--;
    }

    if (asyncStatus) return;

    // Dispatch hero
    if (heroTarget) {
      asyncStatus++;
      const { did, kid, to } = heroTarget;
      const { idleTroops, raidTroops, hero, name, coords } = villageTroops.get(did);

      idleTroops.t11 = 0;
      const { eventName, troops } = raidTroops[kid];
      const rally = createRally({ did, from: { x: coords.x, y: coords.y, name }, to, eventName, troops, hero });
      await rally.dispatch();
      heroTarget = null;
      asyncStatus--;
    }

    // Dispatch raids
    if (rallyQueue.size) {
      asyncStatus++;
      if (goldClub) {
        const sortedQueue = await farmList.updateSlots({ rallyQueue, villageTroops });
        await farmList.send({ rallyQueue, sortedQueue, raidingVillages, raidedTiles });
      } else {
        let delay = 0;
        const reqs = [];

        for (const kid of rallyQueue.keys()) {
          reqs.push(
            new Promise(() => {
              const { rally } = rallyQueue.get(kid);
              const { did } = rally;

              setTimeout(async () => {
                const { idleTroops } = villageTroops.get(did);
                const check = rally.troops.every(({ id, count }) => idleTroops[id] >= count);

                if (check) {
                  rally.troops.forEach(({ id, count }) => (idleTroops[id] -= count));
                  return rally.dispatch();
                } else return null;
              }, delay * 500);
            })
          );

          delay++;
        }

        await Promise.all(reqs);
      }

      rallyQueue.clear();
      asyncStatus--;
    }
  }, 1000);
}

export default main;
