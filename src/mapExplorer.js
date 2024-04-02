async function mapExplorer({ did, storage, tileGetter, farmList: FarmList, coords, callback }) {
  const map = storage.get("map");
  const tileList = storage.get("tileList");
  const list = map[did];

  const { targets } = list;

  const { x: startX, y: startY } = coords;
  const range = 14;

  const startTile = {
    coords,
    distance: 0,
  };

  const lastSession = storage.get("explorer");
  const session =
    lastSession && Number(lastSession.did) === did
      ? lastSession
      : {
          _dX: -1,
          _dY: 1,
          dX: -1,
          dY: 0,
          tile: startTile,
        };

  let _dX = session._dX;
  let _dY = session._dY;

  const { getTileCard } = tileGetter;

  async function explore(dX, dY, currentTile) {
    const { x, y } = currentTile.coords;
    const tile = await getTileCard({ x: x + Math.sign(dX), y: y + Math.sign(dY), did });
    const { kid, distance, type, coords } = tile;
    const typeName = { 1: "Village", 2: "Land", 3: "Unoccupied oasis", 4: "Occupied oasis", 5: "Wilderness" }[type];
    console.log(typeName, distance, coords.x, coords.y);

    storage.set("explorer", { _dX, _dY, dX, dY, did, tile: currentTile });

    await new Promise((res) => setTimeout(res, 1500));

    currentTile.type !== 5 && Math.abs(dX) > 1 && (dX = dX - Math.sign(dX));
    dY !== 0 && (dY = 0);

    if (distance <= range) {
      if (type === 3 || type === 4) {
        const newTarget = { kid, distance, coords };
        targets.findIndex((target) => target.kid === tile.kid) === -1 && targets.push(newTarget) >= 0;
        tileList[kid] = tile;
        storage.save();
      }
    } else if (Math.abs(dX) <= 1) {
      // set direction of Y to move and reverse direction of X
      console.log("Change Y");
      _dX = _dX * -1;
      dX = _dX * Math.abs(startX - x);
      dY = _dY;
    }

    if (Math.abs(y - startY) === range && dY !== 0) {
      // change direction of Y to reverse and restart for bottom half or exit
      if (_dY === -1) return;
      console.log("Switch half");
      _dX = 1;
      _dY = _dY * -1;
      await explore(_dX, 0, startTile);
    }

    await explore(dX, dY, tile);
  }

  callback("Started");
  await explore(session.dX, session.dY, session.tile);

  targets.sort((a, b) => a.distance - b.distance);

  const farmLists = await FarmList.getListsFor(currentVillage);
  const farmList = farmLists.find((list) => list.name === currentVillage.name);
  if (!farmList) {
    const farmList = await FarmList.createFor(currentVillage);
    list.listId = farmList.id;
    await FarmList.createSlots(list);
  } else list.listId = farmList.id;

  map[did].targets = await FarmList.linkTargets({ listId: list.listId, targets });

  if (targets) {
    const { listId } = list;

    updateTiles(
      targets.reduce((acc, { kid, coords, id, distance }) => {
        const villa = tileList[kid].villages.find((v) => Number(v.did) === Number(did));
        if (villa) {
          Object.assign(villa, { id, listId });
        } else {
          tileList[kid].villages.push({ id, listId, distance, did });
        }

        acc.set(kid, { coords });
        return acc;
      }, new Map())
    );
  }

  console.log("Finished");
  storage.set("explorer", null);
}

export default mapExplorer;
