import { fragments, xy2id } from "./index.js";

export function main(data) {
  const {
    storage,
    ownId,
    farmList,
    rallyManager,
    tileGetter,
    villageTroops,
    goldClub,
    noobEndingDate,
    unitsData,
    wss,
    api,
  } = data;
  const { map, rallyCron, tileList, reports, raidList } = storage.getAll();
  const { createRally, raidingVillages, raidedTiles } = rallyManager;
  const { updateTiles, updateQueue } = tileGetter;
  const rallyQueue = new Map();
  const state = {
    escapeEvents: {},
    heroTarget: null,
    async: 0,
    lastTileUpdate: Date.now(),
    lastStatusUpdate: Date.now(),
  };
  const statusQuery = `query { ${fragments.statusQuery} }`;

  const queueTile = (coords, cb) => {
    const kid = xy2id(coords);
    updateQueue.set(kid, {
      coords,
      callback({ tile, report }) {
        if (kid in tileList) {
          tileList[kid] = tile;
          reports[kid] = report;
          storage.save(["tileList", "reports"]);
        }

        cb && cb({ tile, report });

        const { villages = [], owned } = tile;

        const reassigned = [];
        if (!owned) {
          villages.forEach(({ did, distance }) => {
            const raidUnits = villageTroops.get(did).assign({ kid, distance });
            reassigned.push({ did, kid, raidUnits });
          });
        }
        return reassigned;
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
  wss.setRoute("updateTile", ({ coords }) => {
    state.lastTileUpdate = 0;
    queueTile(coords);
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

    // Cleanup expired raids and update status of active raids
    for (const i in raidList) {
      const kid = Number(i);
      const raids = raidList[kid];

      const del = raids.reduce((del, raid, i) => {
        const { did, eventType, eventName, arrivalDate, returnDate, to, units, key } = raid;

        if (eventType !== 9 && now - 500 > arrivalDate) {
          state.lastTileUpdate = 0;
          raid.eventType = 9;

          queueTile(to, ({ report }) => {
            let moreInfo = "";
            if (report.ownerId === ownId) {
              const raids = raidList[kid];
              const raid = raids.find((raid) => raid.key === key);
              let alive = 0;
              let lost = 0;
              for (const id in raid.units) {
                if (id in report.lost) {
                  raid.units[id] -= report.lost[id];
                  lost += report.lost[id];
                }
                alive += raid.units[id];
              }
              if (alive === 0) {
                raid.returnDate = 0;
                moreInfo = `, and died`;
              } else if (lost) {
                moreInfo = `, and lost ${JSON.stringify(report.lost)}`;
              }

              raidedTiles.add(kid);
            }

            console.log(
              `[${new Date().toLocaleTimeString("en-GB", { hour12: false })}] ${eventName} arrived ${JSON.stringify(
                units
              )} to ${JSON.stringify(to)} ${kid}` + moreInfo
            );
          });
        }

        if (eventType === 9 && now - 500 > returnDate) {
          console.log(
            `[${new Date().toLocaleTimeString("en-GB", { hour12: false })}] ${eventName} return ${JSON.stringify(
              units
            )} from ${JSON.stringify(to)} ${kid}`
          );

          const { idleUnits, hero } = villageTroops.get(did);
          for (const id in units) idleUnits[id] += units[id];
          raidingVillages.add(did);
          if (units.t11) hero.idleSince = now;

          del++;
        }

        return del;
      }, 0);

      if (del) {
        raids.splice(0, del);
        if (!raids.length) delete raidList[kid];
      }
    }

    // Reassign departed and arrived village troops.
    if (raidingVillages.size) {
      const toSend = [];
      raidingVillages.forEach((did) => {
        const { targets } = map[did];
        const troopsData = villageTroops.get(did);

        targets.forEach(({ kid, distance }) => {
          if (tileList[kid].owned) return;

          troopsData.assign({ kid, distance });
        });

        toSend.push(troopsData);
      });

      for (const payload of toSend) wss.send({ event: "villageTroops", payload });

      raidingVillages.clear();
    }

    // Send raidList updates
    if (raidedTiles.size) {
      const payload = [];
      raidedTiles.forEach((kid) => payload.push({ kid, raids: raidList[kid] }));
      wss.send({ event: "raidList", payload });
      raidedTiles.clear();
    }

    if (state.async) return;

    // Async dispatch of scheduled raids
    if (rallyCron.length && rallyCron[0].departDate <= now) {
      const toDispatch = [];
      state.async = 1;

      for (let i = 0; i < rallyCron.length; i++) {
        const troopsAction = rallyCron[i];
        if (troopsAction.departDate - now < 1000) {
          const { did, units, eventName } = troopsAction;
          const troopsData = villageTroops.get(did);
          const { idleUnits } = troopsData;

          const check = () => {
            const snapshop = { ...units };
            let totalTroops = 0;

            if (eventName === "escape") {
              rallyQueue.clear();
              troopsAction.units = { ...idleUnits };
              return true;
            }

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
          break;
        }
      }

      if (toDispatch.length > 0) {
        await Promise.all(toDispatch);
        rallyCron.splice(0, toDispatch.length);
        state.async = 0;
      }
      storage.save(["rallyCron"]);
      return;
    }

    // Queue updates and raids
    for (const i in map) {
      const did = Number(i);
      const { listId, targets, autoraid } = map[did];
      if (!targets.length) continue;
      const { idleUnits, raidUnits, name, coords, hero } = villageTroops.get(did);
      const from = { x: coords.x, y: coords.y, name };
      let raidTarget = null;

      for (const { coords, distance, kid, id: targetId } of targets) {
        const tile = tileList[kid];
        const report = reports[kid];

        if (!tile.villages) {
          tile.villages = [{ did, distance, listId, targetId }];
          storage.save(["tileList"]);
        }

        // check occupied oasises every 7 days
        if (tile.type === 4) {
          if (now - tile.timestamp > 6.048e8) queueTile(coords);
          continue;
        }
        /*
          updateQueue.set(kid, {
            coords,
            callback({ tile }) {
              console.log("ownership change " + kid);
              if (!tile.owned) {
                farmList.createSlots({ listId, targets: [{ coords, kid }] });
              }
            },
          });
        */

        const raids = raidList[kid];
        const raidsCount = raids ? raids.filter((raid) => raid.arrivalDate > now).length : 0;
        const isBeginer = now < noobEndingDate && tile.bonus[0].icon !== "r4";
        const isAdvanced = now > noobEndingDate;

        if (isBeginer) {
          if (idleUnits.t1 >= 2 && distance <= 9) {
            if (now - tile.timestamp > 3e5) queueTile(coords);

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
          continue;
        }

        if (isAdvanced && !raidsCount) {
          const isOldTile = now - tile.timestamp > Math.round(Math.max(1, distance / 2 - 2.5) * 6.0e5);
          if (isOldTile && !updateQueue.has(kid)) queueTile(coords);

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
      const tileUpdates = await updateTiles();
      const reassigned = [];
      tileUpdates.forEach((update) => {
        const { cbdata } = update;
        reassigned.push(...cbdata);
        delete update.cbdata;
      });

      if (reassigned.length) wss.send({ event: "raidUnits", payload: reassigned });
      wss.send({ event: "tileList", payload: tileUpdates });

      state.lastTileUpdate = Date.now();
      state.async = 0;
      return;
    }

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
          if (raid) hero.idleSince = raid.returnDate;
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
              const { did, units, eventName, to } = rally;

              setTimeout(async () => {
                const { idleUnits } = villageTroops.get(did);

                const check = () => {
                  for (const id in units) if (idleUnits[id] < units[id]) return false;
                  return true;
                };

                if (check()) {
                  for (const id in units) idleUnits[id] -= units[id];
                  const raid = await rally.dispatch();
                  if (raid && units.t11) villageTroops.hero.idleSince = raid.returnDate;
                  resolve(raid);
                } else {
                  console.log(
                    `[${new Date().toLocaleTimeString("en-GB", {
                      hour12: false,
                    })}] Insufficient units for ${eventName} ${JSON.stringify(units)} to ${JSON.stringify(to)} ${kid}`
                  );
                  resolve(null);
                }
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
      return;
    }

    // Status updates
    if (now - state.lastStatusUpdate > 3e5) {
      state.async = 1;
      const data = await api.graphql({ query: statusQuery, logEvent: "status update" });
      const { hero, villages } = data.ownPlayer;
      const reassigned = villageTroops.update({ hero, villages });
      for (const did in reassigned) wss.send({ event: "villageTroops", payload: reassigned[did] });
      raidingVillages.clear();

      villages.forEach((village) => {
        village.troops.moving.edges.forEach(({ node }) => {
          const {
            id: eventId,
            attackPower,
            troopEvent: { type, arrivalTime, cellTo },
          } = node;

          if (
            !state.escapeEvents[eventId] &&
            (type === 4 || type === 3) &&
            cellTo.village &&
            cellTo.village.id === village.id &&
            attackPower > 1 // TESTING
          ) {
            const hideout = villages.find(({ id }) => id !== village.id);
            console.log("will escape to " + hideout.name);

            const rally = createRally({
              did: village.id,
              from: { x: village.x, y: village.y, name: village.name },
              to: { x: hideout.x, y: hideout.y, name: hideout.name },
              eventName: "escape",
              eventType: 5,
              units: { ...village.ownTroopsAtTown.units },
              departDate: arrivalTime * 1000 - 10000,
            });

            state.escapeEvents[eventId] = rally;
            rallyCron.push(rally);
            storage.save(["rallyCron"]);
            wss.send({ event: "rallyCron", payload: rally });
          }
        });
      });

      state.lastStatusUpdate = now;
      state.async = 0;
    }
  }, 100);
}

export default main;
