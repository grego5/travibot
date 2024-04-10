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
  const rallyQueue = new Map();
  const state = {
    heroTarget: null,
    async: 0,
    lastTileUpdate: 0,
    lastStatusUpdate: Date.now(),
  };
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
    if (data.eventName === "hero") {
      const { did, kid, to } = data;
      state.heroTarget = { kid, did, to, ratio: 999 };
    } else {
      const { kid, listId, targetId } = data;
      rallyQueue.set(kid, { id: targetId, listId, rally: createRally(data) });
    }
  });
  wss.setRoute("updateTile", ({ kid, coords }) => {
    state.lastTileUpdate = 0;
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

    // Cleanup expired raids. Queue update for arrived raids.
    for (const i in raidList) {
      const kid = Number(i);
      const activeRaids = raidList[kid].filter(({ did, eventType, eventName, returnDate, units }) => {
        if (eventType === 9 && returnDate < now) {
          console.log(
            `[${new Date().toLocaleTimeString("en-GB", { hour12: false })}] raid return ${JSON.stringify(units)}`
          );

          const { idleUnits, hero } = villageTroops.get(did);
          for (const id in units) idleUnits[id] += units[id];
          raidingVillages.find((v) => v.did === did) || raidingVillages.push(did);
          if (units.t11) hero.idleSince = now;

          return false;
        } else return true;
      });

      if (activeRaids.length < raidList[kid].length) {
        raidList[kid] = activeRaids;
        raidedTiles.push({ kid, raids: activeRaids });
        storage.save();
      }

      const currentRaid = activeRaids[0];

      // Check and update status of the current raid
      if (currentRaid && currentRaid.arrivalDate < now && currentRaid.eventType !== 9) {
        state.lastTileUpdate = 0;

        updateQueue.set(kid, {
          coords: currentRaid.to,
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
              let alive = 0;
              for (const id in currentRaid.units) {
                currentRaid.units[id] -= report.casualties[id];
                alive += currentRaid.units[id];
              }
              if (alive === 0) currentRaid.returnDate = 0;

              // dead
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

    // Reassign departed and arrived village troops. Update raidList
    if (raidedTiles.length) {
      const reassigned = reassignTroops(raidingVillages);
      wss.send({ event: "raidList", payload: raidedTiles });
      for (const did in reassigned) wss.send({ event: "villageTroops", payload: reassigned[did] });
      raidedTiles.length = 0;
      raidingVillages.length = 0;
    }

    if (state.async) return;

    // Scheduled raids
    if (rallyCron.length && rallyCron[0].departDate <= now) {
      const toDispatch = [];
      state.async = 1;

      for (let i = 0; i < rallyCron.length; i++) {
        const troopsAction = rallyCron[i];
        if (troopsAction.departDate - now < 1000) {
          const { did, units } = troopsAction;
          const troopsData = villageTroops.get(did);
          const { idleUnits } = troopsData;

          const check = () => {
            const snapshop = { ...units };
            let totalTroops = 0;

            for (const id in units) {
              const count = units[id];
              if (idleUnits[id] < Math.ceil(count * 0.9)) {
                troopsData.idleUnits = snapshop;
                return false;
              }

              const available = Math.min(count, idleUnits[id]);
              units[id] = available;
              totalTroops += available;
              idleUnits[id] -= available;
            }

            if (units.t11) troopsAction.hero = troopsData.hero;

            return true;
          };

          if (check()) {
            toDispatch.push(
              createRally(troopsAction)
                .dispatch()
                .then((raid) => {
                  if (units.t11) troopsData.hero.idleSince = raid.returnDate;
                })
                .catch((error) => {
                  console.error("Error dispatching rally:", error);
                })
            );
          }
        } else {
          break; // No need to continue loop if departure time is in the future
        }
      }

      if (toDispatch.length > 0) {
        await Promise.all(toDispatch);
        rallyCron.splice(0, toDispatch.length);
        state.async = 0;
      }
      storage.save();
      return;
    }

    // Status updates
    if (now - state.lastStatusUpdate > 3e5) {
      state.async = 1;
      const data = await api.graphql({ query: statusQuery, logEvent: "status update" });
      const { hero, villages } = data.ownPlayer;
      const reassigned = villageTroops.update({ hero, villages });
      for (const did in reassigned) wss.send({ event: "villageTroops", payload: reassigned[did] });
      raidingVillages.length = 0;
      state.lastStatusUpdate = now;
      state.async = 0;
      return;
    }

    // Queue updates and raids
    for (const i in map) {
      const did = Number(i);
      const { listId, targets, autoraid } = map[did];
      const { idleUnits, raidUnits, assign: assignTroops, name, coords, hero } = villageTroops.get(did);
      const from = { x: coords.x, y: coords.y, name };
      let raidTarget = null;

      for (const { coords, distance, kid, id: targetId } of targets) {
        const tile = tileList[kid];
        const report = reports[kid] || { scoutDate: 0, timestamp: now, loot: 0 };

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
        const isBeginer = nextStageDate > now && tile.bonus[0].icon !== "r4";
        const isAdvanced = nextStageDate < now;

        if (isBeginer) {
          if (idleUnits.t1 >= 2 && distance <= 9) {
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

          const { eventName, units, forecast } = raidUnits[kid];

          if (eventName) {
            const { ratio } = forecast;

            switch (eventName) {
              case "raid":
                if (!raidTarget || raidTarget.ratio < ratio) raidTarget = { kid, did, ratio, to: coords, targetId };
                break;
              case "hero":
                if (now - hero.idleSince > 60000 && (!state.heroTarget || state.heroTarget.ratio < ratio))
                  state.heroTarget = { kid, did, to: coords, ratio };
                break;
              default:
                rallyQueue.set(kid, {
                  id: targetId,
                  listId,
                  rally: createRally({
                    did,
                    from,
                    eventName,
                    to: coords,
                    units,
                    scoutTarget: eventName === "scout" ? 1 : 0,
                  }),
                });
            }
          }
        }
      }

      if (raidTarget) {
        const { kid, did, targetId, to } = raidTarget;
        const { raidUnits, coords, name } = villageTroops.get(did);
        const { units, eventName } = raidUnits[kid];

        rallyQueue.set(kid, {
          id: targetId,
          listId,
          rally: createRally({ did, from: { x: coords.x, y: coords.y, name }, to, eventName, units }),
        });
      }
    }

    // Update tiles
    if (
      (updateQueue.size >= 3 && (now - state.lastTileUpdate >= 6e4 || updateQueue.size >= 10)) ||
      (updateQueue.size && now - state.lastTileUpdate >= 6e5)
    ) {
      state.async = 1;
      const updates = await updateTiles();
      wss.send({ event: "tileList", payload: updates });
      const villages = villageTroops.getAll();
      for (const did in villages) wss.send({ event: "villageTroops", payload: villages[did] });
      raidingVillages.length = 0;
      state.lastTileUpdate = Date.now();
      state.async = 0;
      return;
    }

    if (state.async) return;
    const toDispatch = [];

    // Dispatch hero
    if (state.heroTarget) {
      state.async = 1;
      const { did, kid, to } = state.heroTarget;
      const { idleUnits, raidUnits, hero, name, coords } = villageTroops.get(did);

      idleUnits.t11 = 0;
      const { eventName, units } = raidUnits[kid];
      const rally = createRally({ did, from: { x: coords.x, y: coords.y, name }, to, eventName, units, hero });
      toDispatch.push(
        rally.dispatch().then((raid) => {
          hero.idleSince = raid.returnDate;
          state.heroTarget = null;
        })
      );
    }

    // Dispatch raids
    if (rallyQueue.size) {
      state.async = 1;

      if (goldClub) {
        toDispatch.push(
          farmList
            .updateSlots({ rallyQueue, villageTroops })
            .then(({ sortedQueue }) => farmList.send({ rallyQueue, sortedQueue, rallyManager }))
        );
      } else {
        let delay = 0;

        for (const kid of rallyQueue.keys()) {
          toDispatch.push(
            new Promise((resolve) => {
              const { rally } = rallyQueue.get(kid);
              const { did, units } = rally;

              setTimeout(async () => {
                const { idleUnits } = villageTroops.get(did);

                const check = () => {
                  for (const id in units) if (idleUnits[id] < units[id]) return false;
                  return true;
                };

                if (check()) {
                  for (const id in units) idleUnits[id] -= units[id];
                  const raid = await rally.dispatch();
                  if (units.t11) villageTroops.hero.idleSince = raid.returnDate;
                  resolve(raid);
                } else resolve(null);
              }, delay * 500);
            })
          );

          delay++;
        }
      }

      rallyQueue.clear();
    }

    if (toDispatch.length) {
      await Promise.all(toDispatch);
      state.async = 0;
    }
  }, 100);
}

export default main;
