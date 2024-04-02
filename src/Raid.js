export default class Raid {
  constructor({ did, eventName = "", eventType, travelTime, returnTime, arrivalDate, returnDate, troops, coords }) {
    this.origin = did;
    this.coords = coords;
    this.status = eventName.toLowerCase() === "scout" ? 2 : 1;
    this.eventName = eventName;
    this.travelTime = travelTime;
    this.departDate =
      eventType === 9 ? arrivalDate - travelTime * 2 : arrivalDate ? arrivalDate - travelTime : Date.now();
    this.arrivalDate = this.departDate + travelTime;
    this.returnDate = returnDate ? returnDate : this.arrivalDate + (eventType === 5 ? 0 : returnTime);
    this.troops = troops;
    this.recall_id =
      troops.reduce((acc, { id, count }) => (acc += `${id}c${count}`), "") +
      "d" +
      new Date(this.arrivalDate - (this.arrivalDate % 10000)).toLocaleTimeString("en-GB");
  }
}
