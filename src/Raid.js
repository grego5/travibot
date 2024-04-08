export default class Raid {
  constructor({
    did,
    from,
    to,
    eventName = "",
    eventType = 4,
    travelTime,
    returnTime,
    departDate,
    arrivalDate,
    returnDate,
    troops,
  }) {
    this.did = did;
    this.from = from;
    this.to = to;
    this.eventType = eventType;
    this.eventName = eventName;
    this.travelTime = travelTime;
    this.departDate = departDate
      ? departDate
      : eventType === 9
      ? arrivalDate - travelTime * 2
      : arrivalDate
      ? arrivalDate - travelTime
      : Date.now();
    this.arrivalDate = arrivalDate ? arrivalDate : this.departDate + travelTime;
    this.returnDate = returnDate ? returnDate : this.arrivalDate + (eventType === 5 ? 0 : returnTime);
    this.troops = troops;
    this.recall = new Date(this.arrivalDate - (this.arrivalDate % 10000)).toLocaleTimeString("en-GB");
    this.recall += troops.reduce((acc, { id, count }) => (acc += `:${id}:${count}`), "");
  }
}
