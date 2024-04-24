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
      : Math.floor(Date.now() / 1000) * 1000;
    this.arrivalDate = arrivalDate ? arrivalDate : this.departDate + travelTime;
    this.returnDate = returnDate ? returnDate : this.arrivalDate + (eventType === 5 ? 0 : returnTime);
    this.units = units;
    this.recall = new Date(Math.floor(this.arrivalDate / 10000) * 10000).toLocaleTimeString("en-GB");
    ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11"].forEach((id) => {
      if (units[id]) this.recall += `:${id}:${units[id]}`;
    });
  }
}
