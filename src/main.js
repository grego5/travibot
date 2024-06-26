import { xy2id, logMessage, Query } from "./index.js";

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
  const { map, rallyCron, tileList, reports, raidList, tribes } = storage.getAll();
  const { createRally, raidingVillages, raidedTiles } = rallyManager;
  const { updateTiles, updateQueue } = tileGetter;
  const rallyQueue = new Map();
  const state = {
    escapeEvents: {},
    heroTarget: null,
    async: 0,
    last: null,
    lastTileUpdate: Math.floor(Date.now() / 1000) * 1000,
    nextStatusUpdate: Date.now() + 3e4,
  };

  const statusQuery = new Query("hero", "raidin", "idleTroops");
  const moveoutQuery = new Query("$moveout").addVar("id", "Int");

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
    const now = Math.floor(Date.now() / 1000) * 1000;
    const raid = raidList[kid].find((raid) => raid.recall === recall);
    const { from, eventName, units, to } = raid;
    logMessage(`${from.name} recalled ${eventName} ${JSON.stringify(units)} to ${JSON.stringify(to)} ${kid}`);
    raid.returnDate = now - raid.departDate + now;
    raid.arrivalDate = 0;
    raid.eventType = 9;
    raid.eventName = "recall";
    raidedTiles.add(kid);
  });

  setInterval(async () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    if (state.async && now - state.async > 10000) {
      console.log("stuck in ", state.last);
    }
    wss.ping(now);

    // Cleanup expired raids and update status of active raids
    for (const i in raidList) {
      const kid = Number(i);
      const raids = raidList[kid];

      const toDelete = raids.findLastIndex((raid) => {
        const { did, from, to, units, eventType, eventName, arrivalDate, returnDate, key } = raid;

        if (eventType !== 9 && now >= arrivalDate) {
          raid.eventType = 9;
          raid.eventName = "recall";

          if (eventName[0] === "e") {
            api.graphql({ query: moveoutQuery, variables: { id: did } }).then((data) => {
              data.ownVillage.troops.moveout.edges.every(({ node }) => {
                const { troopEvent, units } = node;
                const { arrivalTime } = troopEvent;
                let recall = new Date(Math.floor(arrivalTime / 10) * 10000).toLocaleTimeString("en-GB");
                tribes[0].forEach((id) => {
                  if (units[id]) recall += `:${id}:${units[id]}`;
                });

                if (recall === raid.recall) {
                  api.run({
                    pathname: `/api/v1/troop/${node.id}/recall`,
                    method: "POST",
                    villageId: did,
                    logEvent: "escape recall",
                  });

                  state.nextStatusUpdate = returnDate;

                  return false;
                }
                return true;
              });
            });

            return false;
          }

          state.lastTileUpdate = 0;

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

            logMessage(
              `${from.name} ${eventName} has arrived ${JSON.stringify(units)} to ${JSON.stringify(to)} ${kid}` +
                moreInfo
            );
          });

          return false;
        }

        if (eventType === 9 && now >= returnDate) {
          logMessage(
            `${from.name} ${eventName} has returned ${JSON.stringify(units)} from ${JSON.stringify(to)} ${kid}`
          );

          const { idleUnits, hero } = villageTroops.get(did);
          for (const id in units) idleUnits[id] += units[id];
          raidingVillages.add(did);
          if (units.t11) hero.idleSince = now;

          return true;
        }
      });

      raids.splice(0, toDelete + 1);
      if (!raids.length) delete raidList[kid];
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
    if (rallyCron.length && rallyCron[0].departDate - 1000 < now) {
      const toDispatch = [];
      let toDelete = 0;

      for (let i = 0; i < rallyCron.length; i++) {
        const troopsAction = rallyCron[i];
        if (troopsAction.departDate > now) break;

        const { did, units, eventName, from, to, returnDate } = troopsAction;
        const troopsData = villageTroops.get(did);
        const { idleUnits } = troopsData;
        let totalTroops = 0;

        if (eventName[0] === "e") {
          const autoscape = map[did].autosettings.escape;
          delete state.escapeEvents[did];

          tribes[0].forEach((id) => {
            if (idleUnits[id] * autoscape[id]) {
              units[id] = idleUnits[id];
              totalTroops += idleUnits[id];
              idleUnits[id] = 0;
            }
          });
        } else {
          const snapshot = { ...units };

          for (const id in units) {
            const count = units[id];
            if (idleUnits[id] < Math.ceil(count * 0.9)) {
              troopsData.idleUnits = snapshot;
              return 0;
            }

            const available = Math.min(count, idleUnits[id]);
            units[id] = available;
            totalTroops += available;
            idleUnits[id] -= available;
          }
        }

        if (totalTroops) {
          troopsAction.hero = troopsData.hero;

          toDispatch.push(
            createRally(troopsAction)
              .dispatch()
              .then((raid) => {
                if (eventName[0] === "e") {
                  raid.travelTime = Math.min((returnDate - raid.departDate) / 2, 89000);
                  raid.arrivalDate = raid.departDate + raid.travelTime;
                  raid.returnDate = raid.arrivalDate + raid.travelTime;
                }

                if (raid.units.t11) troopsData.hero.idleSince = raid.returnDate;
              })
              .catch((error) => console.error(error))
          );

          if (toDispatch.length === 1) {
            state.async = now;
            state.last = "rallycron";
            await toDispatch[0];
          }
        } else {
          toDelete = i + 1;
          logMessage(
            `${from.name} ${eventName} to ${JSON.stringify(to)} canceled. Insufficient units ${JSON.stringify(units)}`
          );
        }
      }

      if (toDispatch.length > 0) {
        await Promise.all(toDispatch);
        state.async = 0;
      }

      rallyCron.splice(0, Math.max(toDispatch.length, toDelete));
      storage.save(["rallyCron"]);
      wss.send({ event: "rallyCron", payload: rallyCron });
      return;
    }

    // Queue updates and raids
    for (const i in map) {
      const did = Number(i);
      const { listId, targets, autoraid, autosettings } = map[did];
      if (!autoraid || !targets.length) continue;
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
          if (now - tile.timestamp >= 6.048e8) queueTile(coords);
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

        if (now < noobEndingDate) {
          if (idleUnits.t1 * autosettings[t1] >= 2 && distance <= 9) {
            if (now - tile.timestamp >= 3e5) queueTile(coords);

            if (updateQueue.size || rallyQueue.has(kid)) continue;

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

        if (now > noobEndingDate && !raidsCount) {
          const isOldTile = now - tile.timestamp >= Math.round(Math.max(1, distance / 2 - 2.5) * 6.0e5);
          if (isOldTile && !updateQueue.has(kid)) queueTile(coords);

          if (updateQueue.size || rallyQueue.has(kid)) continue;

          const { eventName, units, forecast } = raidUnits[kid];

          if (eventName) {
            const { ratio } = forecast;

            switch (eventName) {
              case "raid":
                if (!raidTarget || raidTarget.ratio < ratio) raidTarget = { kid, did, ratio, to: coords, targetId };
                break;
              case "hero":
                if (
                  autosettings.raid.t11 &&
                  now - hero.idleSince >= 60000 &&
                  (!state.heroTarget || state.heroTarget.ratio < ratio)
                )
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
      state.async = now;
      state.last = "tile updates";
      const tileUpdates = await updateTiles();
      const reassigned = [];
      tileUpdates.forEach((update) => {
        const { cbdata } = update;
        reassigned.push(...cbdata);
        delete update.cbdata;
      });

      if (reassigned.length) wss.send({ event: "raidUnits", payload: reassigned });
      wss.send({ event: "tileList", payload: tileUpdates });

      state.lastTileUpdate = Math.floor(Date.now() / 1000) * 1000;
      state.async = 0;
      return;
    }

    const toDispatch = [];

    // Dispatch hero
    if (state.heroTarget) {
      state.async = now;
      state.last = "hero dispatch";
      const { did, kid, to } = state.heroTarget;
      const { idleUnits, raidUnits, hero, name, coords } = villageTroops.get(did);

      idleUnits.t11 = 0;
      const { eventName, units } = raidUnits[kid];
      const rally = createRally({ did, from: { x: coords.x, y: coords.y, name }, to, eventName, units, hero });
      toDispatch.push(
        rally
          .dispatch()
          .then((raid) => raid && (hero.idleSince = raid.returnDate))
          .catch((error) => console.log(error))
          .finally(() => (state.heroTarget = null))
      );
    }

    // Dispatch raids
    if (rallyQueue.size) {
      state.async = now;
      state.last = "rally queue dispatch";

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
              const { did, units, eventName, to, from } = rally;

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
                  logMessage(
                    `${from.name} ${eventName} to ${JSON.stringify(to)} canceled. Insufficient units ${JSON.stringify(
                      units
                    )}`
                  );

                  if (kid in tileList) {
                    const { distance } = tileList[kid].villages.find((village) => village.did === did);
                    villageTroops.get(did).assign({ kid, distance });
                  }
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
    if (now >= state.nextStatusUpdate) {
      state.async = now;
      state.last = "status update";
      const data = await api.graphql({ query: statusQuery, logEvent: "status update" });
      const { hero, villages } = data.ownPlayer;
      let update = 0;

      villages.forEach((village) => {
        if (!map[village.id]) {
          map[village.id] = {
            targets: [],
            autoraid: 0,
            autosettings: {
              raid: { t1: 0, t2: 0, t3: 0, t4: 0, t5: 0, t6: 0, t7: 0, t8: 0, t9: 0, t10: 0, t11: 0 },
              escape: { t1: 1, t2: 1, t3: 1, t4: 1, t5: 1, t6: 1, t7: 1, t8: 1, t9: 1, t10: 1, t11: 1 },
            },
          };
        }
      });

      const reassigned = villageTroops.update({ hero, villages });
      for (const did in reassigned) wss.send({ event: "villageTroops", payload: reassigned[did] });
      raidingVillages.clear();

      villages.forEach((village) => {
        village.troops.raidin.edges.forEach(({ node }) => {
          const {
            id,
            attackPower,
            troopEvent: { arrivalTime },
          } = node;

          // TEST
          if (attackPower > 1) {
            const attackDate = arrivalTime * 1000;
            const escapeEvent = state.escapeEvents[village.id];

            if (!escapeEvent) {
              const hideout = villages.find(({ id }) => id !== village.id);

              const troopsAction = {
                did: village.id,
                from: { x: village.x, y: village.y, name: village.name },
                to: { x: hideout.x, y: hideout.y, name: hideout.name },
                units: {},
                eventName: "escape",
                eventType: 5,
                departDate: attackDate - 2000,
                returnDate: attackDate + 1000,
                key: id,
              };

              const date1 = new Date(troopsAction.departDate).toLocaleTimeString("en-GB", { hour12: false });
              const date2 = new Date(troopsAction.returnDate).toLocaleTimeString("en-GB", { hour12: false });

              logMessage(`${village.name} will escape to ${hideout.name} at ${date1} and return at ${date2}`);

              state.escapeEvents[village.id] = troopsAction;
              rallyCron.push(troopsAction);
              update = 1;
            } else {
              if (escapeEvent.departDate > attackDate - 2000) {
                escapeEvent.departDate = attackDate - 2000;
                const date1 = new Date(escapeEvent.departDate).toLocaleTimeString("en-GB", { hour12: false });
                logMessage(`${village.name} escape depart date changed to ${date1}`);
                update = 1;
              }

              const recallWindow = escapeEvent.returnDate - escapeEvent.departDate < 178000;
              if (
                !recallWindow ||
                (attackDate >= escapeEvent.returnDate && attackDate - escapeEvent.departDate < 178000)
              ) {
                escapeEvent.returnDate = attackDate + 1000;
                const date2 = new Date(escapeEvent.returnDate).toLocaleTimeString("en-GB", { hour12: false });
                logMessage(`${village.name} escape return date changed to ${date2}`);
                update = 1;
              }
            }
          }
        });
      });

      if (update) {
        rallyCron.sort((a, b) => a.departDate - b.departDate);
        storage.save(["rallyCron"]);
        wss.send({ event: "rallyCron", payload: rallyCron });
      }

      state.nextStatusUpdate += 3e5;
      state.async = 0;
    }
  }, 100);

  return state;
}

export default main;
