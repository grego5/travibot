export default class Raid {
  constructor(props) {
    const { did, from, to, eventName, eventType, travelTime, returnTime, departDate, arrivalDate, returnDate, units } =
      props;
    this.did = did;
    this.from = from;
    this.to = to;
    this.eventType = eventType || 4;
    this.eventName = eventName || "";
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
    this.units = units;
    this.recall = new Date(this.arrivalDate - (this.arrivalDate % 10000)).toLocaleTimeString("en-GB");
    for (const id in units) this.recall += `:${id}:${units[id]}`;
  }
}
