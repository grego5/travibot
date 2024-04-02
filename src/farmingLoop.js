export function farmingLoop(data) {
  const { storage, ownId, farmList, rallyManager, tileGetter, villageTroops, goldClub, peaceEndingDate, tribeId } =
    data;
  const { map, rallyCron, tileList = {}, reports = {}, raidList } = storage.getAll();
  const unitsData = storage.get("tribesData")[tribeId];
  const { createRally } = rallyManager;
  const { updateTiles } = tileGetter;

  const reassignTroops = (raidingVillages) => {
    for (const did of raidingVillages) {
      const { targets } = map[did];
      const { assign: assignTroops } = villageTroops.get(did);

      targets.forEach(({ kid, distance }) => {
        if (tileList[kid].owned) return;

        assignTroops({ kid, distance });
      });
    }
  };

  const rallyQueue = new Map();
  const updateQueue = new Map();
  let lastUpate = 0;
  let heroTarget = null;

  const queueTile = ({ kid, coords, force, callback }) => {
    if (force) lastUpate = 0;
    updateQueue.set(kid, {
      coords: coords || tileList[kid].coords,
      callback({ tile, report }) {
        tileList[kid] = tile;
        reports[kid] = report;
        storage.save();

        const { villages = [], owned } = tile;

        !owned &&
          villages.forEach(({ did, distance }) => {
            villageTroops.get(did).assign({ kid, distance });
          });

        callback && callback({ tile, report });
      },
    });
  };

  const queueRally = ({ rally, callback }) => {
    const { kid } = rally;
    const { listId, id } = tileList[kid].villages.find((village) => village.did === rally.did);
    rallyQueue.set(kid, { id, listId, rally, callback });
  };

  setInterval(async () => {
    const now = Date.now();

    for (const next of rallyCron) {
      if (next.departure - now > 1000) break;

      const { did, troops } = next;
      const { idleTroops } = villageTroops.get(did);

      troops.forEach((unit) => {
        const available = Math.min(unit.count, idleTroops[unit.id]);
        unit.count = available;
        idleTroops[unit.id] -= available;
      });

      createRally(rallyCron.shift()).dispatch();
      storage.save();
    }

    // cleanup expired raids

    for (const kid in raidList) {
      const activeRaids = raidList[kid].filter(({ origin, status, returnDate, troops }) => {
        if (returnDate <= now && status >= 3) {
          const { idleTroops } = villageTroops.get(origin);
          troops.forEach(({ id, count }) => (idleTroops[id] += count));
          return false;
        } else return true;
      });

      if (activeRaids.length < raidList[kid].length) {
        if (!activeRaids.length) {
          delete raidList[kid];
        } else raidList[kid] = activeRaids;

        storage.save();
      }

      const currentRaid = activeRaids[0];

      // check and update status of the current raid

      if (currentRaid && currentRaid.arrivalDate <= now && currentRaid.status < 3) {
        const { coords } = currentRaid;

        lastUpate = 0;
        updateQueue.set(kid, {
          coords,
          callback({ tile, report }) {
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
            currentRaid.status += 2;

            raids.sort((a, b) => {
              const dateA = a.status >= 3 ? a.returnDate : a.arrivalDate;
              const dateB = b.status >= 3 ? b.returnDate : b.arrivalDate;
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

    for (const i in map) {
      const did = Number(i);
      const { listId, targets, autoraid } = map[did];
      const { totalTroops, idleTroops, raidTroops, assign: assignTroops } = villageTroops.get(did);
      let raidTarget = null;

      for (const { coords, distance, kid, id: targetId } of targets) {
        const tile = tileList[kid];
        const report = reports[kid] || { scoutDate: 0, timestamp: now, loot: 0 };

        if (!tile) {
          queueTile({ kid, coords });
          continue;
        }

        if (tile.type === 4) {
          // check occupied oasises every 7 days
          if (now - tile.timestamp > 6.048e8) {
            updateQueue.set(kid, {
              coords,
              callback({ tile }) {
                if (!tile.owned) {
                  farmList.createSlots({ listId, targets: [{ coords, kid }] });
                }
              },
            });
          }
          continue;
        }

        if (!raidTroops[kid]) assignTroops({ kid, distance });
        const raids = raidList[kid];
        const raidsCount = raids ? raids.filter((raid) => raid.arrivalDate < now).length : 0;
        const isBeginer = peaceEndingDate > now && (tile.bonus[0].icon !== "r4" || totalTroops.t1 > 40);
        const isAdvanced = peaceEndingDate < now;

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
            if ({ raid: 1, hero: 1 }[eventName]) {
              const { ratio } = forecast;
              if (!raidTarget || raidTarget.ratio < ratio) raidTarget = { kid, ratio, coords, targetId };
            }

            if (raidTarget) continue;

            rallyQueue.set(kid, {
              id: targetId,
              listId,
              rally: createRally({ did, eventName, coords, troops: [...troops] }),
            });
          }
        }
      }

      if (raidTarget) {
        const { kid, targetId, coords } = raidTarget;
        const { eventName, troops } = raidTroops[kid];
        if (eventName === "hero" && !heroTarget) heroTarget = kid;

        rallyQueue.set(kid, {
          id: targetId,
          listId,
          rally: createRally({ did, eventName, coords, troops: [...troops] }),
        });
      }
    }

    if (updateQueue.size && (now - lastUpate >= 6e4 || updateQueue.size >= 10 || rallyQueue.size)) {
      await updateTiles(updateQueue).then(() => {
        updateQueue.clear();
        lastUpate = Date.now();
      });
    }

    if (rallyQueue.size) {
      if (heroTarget) {
        const rally = rallyQueue.get(heroTarget).rally;
        const { idleTroops } = villageTroops.get(rally.did);
        console.log(`Hero will be sent to ${rally.coords.x} | ${rally.coords.y}`);

        setTimeout(() => {
          if (idleTroops.t11) {
            idleTroops.t11 = 0;
            rally.dispatch().then(() => {
              heroTarget = null;
            });
          }
        }, 20000);

        rallyQueue.delete(heroTarget);
        if (!rallyQueue.size) return;
      }

      if (goldClub) {
        farmList.updateSlots({ rallyQueue, villageTroops }).then(async (sortedQueue) => {
          const raidingVillages = await farmList.send({ rallyQueue, sortedQueue });
          reassignTroops(raidingVillages);
          rallyQueue.clear();
        });
      } else {
        let delay = 0;
        let completed = 0;
        const raidingVillages = [];

        for (const kid of rallyQueue.keys()) {
          const { rally, callback } = rallyQueue.get(kid);
          const { did } = rally;

          setTimeout(async () => {
            const { idleTroops } = villageTroops.get(did);
            const check = rally.troops.every(({ id, count }) => idleTroops[id] >= count);

            if (check) {
              rally.troops.forEach(({ id, count }) => (idleTroops[id] -= count));
              if (!raidingVillages.find((id) => id === did)) raidingVillages.push(did);
              rally.dispatch().then((raids) => callback && callback(raids));
            }

            completed++;

            if (completed === rallyQueue.size) {
              rallyQueue.clear();
              reassignTroops(raidingVillages);
            }
          }, delay * 500);
          delay++;
        }
      }
    }
  }, 1000);

  return {
    queueTile,
    queueRally,
  };
}

export default farmingLoop;
