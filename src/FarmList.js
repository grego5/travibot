import { Raid } from "./index.js";

class FarmList {
  constructor({ api, storage }) {
    this.storage = storage;
    this.api = api;
    this.api.addRoutes([
      { name: "farmList", path: "/farm-list", methods: ["GET"] },
      { name: "farmListSlot", path: "/farm-list/slot", methods: ["POST", "PUT"] },
      { name: "farmListSend", path: "/farm-list/send", methods: ["POST"] },
    ]);
  }

  units = { t1: 0, t2: 0, t3: 0, t4: 0, t5: 0, t6: 0, t7: 0, t8: 0, t9: 0, t10: 0 };

  getList = async (id) => {
    const query = `query ($id: ID!){
       farmList(id: $id)  {
         id,
         name
       }
     }
   
     `;

    const variables = {
      id,
    };

    const { farmList } = await this.api.graphql({ query, variables, logEvent: "Get farmlist for " + id });
    return farmList;
  };

  getListsFor = async (village) => {
    const query = `query{
       ownPlayer {
         farmLists {
           id,
           name,
           ownerVillage {
             id
           }
           slots {
             id
             distance
             target { mapId, x, y, name, type }
         },
         }
       }
     }
     `;

    const data = await this.api.graphql({ query, logEvent: "Get farmlists for " + village.id });
    const lists = data.ownPlayer.farmLists.filter((list) => list.ownerVillage.id === village.id);
    return lists;
  };

  createFor = async (village) => {
    const { id, name } = village;
    const newList = {
      villageId: id,
      name,
      defaultUnits: { ...this.units, t1: 1 },
    };
    try {
      const res = await this.api.farmList.get({ body: newList, logEvent: "Create farmlist" });

      if (!res.ok) {
        const { error, message } = await res.json();
        if (error === "raidList.uniqueFarmListNameError")
          return this.getListsFor(village).find((list) => list.name === village.name);
        throw new Error(message);
      }

      const data = await res.json();

      return data;
    } catch ({ message }) {
      console.log(message);
      return null;
    }
  };

  linkList = ({ list, village }) => {
    village.listId = list.id;
    list.slots.forEach((slot) => {
      const { id, distance, target } = slot;
      const { mapId: kid, x, y } = target;
      village.targets.push({ kid, id, distance: Math.round(distance * 10) / 10, coords: { x, y } });
    });

    return village;
  };

  createSlots = async ({ listId, targets }) => {
    if (!targets.length) return [];

    const farmSlots = {
      slots: targets.map(({ coords }) => {
        const { x, y } = coords;
        return { listId, x, y, units: { ...this.units, t1: 1 }, active: true };
      }),
    };

    await this.api.farmListSlot.post({ body: farmSlots, logEvent: "Create farmlist slots" });

    return true;
  };

  linkTargets = async ({ listId, targets }) => {
    const query = `query {
       farmList(id: ${listId}) {
         slots { 
           id
           target { mapId }
         }
       }
     }`;

    const { farmList } = await this.api.graphql({ query, logEvent: "Link farmlist" });
    const { slots } = farmList;

    return targets.map(function (t) {
      const slot = slots.find(({ target: s }) => s.mapId === t.kid);
      t.id = slot.id;
      return t;
    });
  };

  updateSlots = async ({ rallyQueue, villageTroops }) => {
    const listIndex = {};
    const sortedQueue = [];
    const slots = [];
    const deleteEntries = [];

    rallyQueue.forEach(({ id, listId, rally }, kid) => {
      const { idleTroops } = villageTroops.get(rally.did);
      const check = rally.troops.every(({ id, count }) => idleTroops[id] >= count);

      if (!check) {
        deleteEntries.push(kid);

        return;
      }

      const units = rally.troops.reduce(
        (units, { id, count }) => {
          idleTroops[id] -= count;
          units[id] = count;
          return units;
        },
        { ...this.units }
      );

      if (listId in listIndex) {
        sortedQueue[listIndex[listId]].targets.push(id);
      } else {
        listIndex[listId] = sortedQueue.push({ id: listId, targets: [id] }) - 1;
      }

      slots.push({
        active: true,
        id,
        listId,
        units,
      });
    });

    deleteEntries.forEach((key) => rallyQueue.delete(key));

    await this.api.farmListSlot.put({ slots, logEvent: "Update farmlist slots" });

    return sortedQueue;
  };

  send = async ({ sortedQueue, rallyQueue, raidingVillages = [], raidedTiles = [] }) => {
    // refactor listId and prep data with iterator

    const farmListSend = {
      action: "farmList",
      lists: sortedQueue,
    };

    await this.api.farmListSend.post({ body: farmListSend, logEvent: "Send farmlist" }).then(async (res) => {
      const { lists } = await res.json();

      lists.forEach(({ error, id, targets }) => {
        if (error) return console.log(id, error);
        targets.forEach(({ error, id }) => {
          if (error) console.log(id, error);
        });
      });
    });

    let query = `query { `;
    rallyQueue.forEach(
      ({ id }) => (query += `s${id}: farmSlot(id: ${id}) { id distance nextAttackAt target { mapId }} `)
    );
    query += ` }`; // s1: farmSlot(id: 1) { ...SlotDetails }

    const data = await graphql({ query });
    const now = Date.now();
    const raidList = this.storage.get("raidList");

    rallyQueue.forEach(({ id, rally }, kid) => {
      const { nextAttackAt } = data[`s${id}`];
      const travelTime = parseInt(nextAttackAt + "000") - now;
      const { eventName, eventType, troops, did, to, from } = rally;
      const raid = new Raid({ did, to, from, eventName, eventType, travelTime, returnTime: travelTime, troops });
      if (!raidingVillages.find((id) => id === did)) raidingVillages.push(did);

      const raids = raidList[kid] || (raidList[kid] = []);
      raids.push(raid);
      raids.sort((a, b) => {
        const dateA = a.eventType === 9 ? a.returnDate : a.arrivalDate;
        const dateB = b.eventType === 9 ? b.returnDate : b.arrivalDate;
        return dateA - dateB;
      });
      raidedTiles.find((t) => {
        if (t.kid === kid) {
          t.raids = raids;
          return true;
        }
      }) || raidedTiles.push({ kid, raids });
    });
    this.storage.save();
    return { raidingVillages, raidedTiles };
  };
}

export default FarmList;
