const urlMark = 'https://api.india.delta.exchange/v2/history/candles?symbol=MARK:C-BTC-77800-230426&resolution=1h&start=1776909600&end=1776950000';
const urlLtp = 'https://api.india.delta.exchange/v2/history/candles?symbol=C-BTC-77800-230426&resolution=1h&start=1776909600&end=1776950000';

Promise.all([
  fetch(urlMark, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.json()),
  fetch(urlLtp, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.json())
]).then(([markData, ltpData]) => {
  console.log("MARK REST API:");
  console.log(markData.result);
  console.log("LTP REST API:");
  console.log(ltpData.result);
}).catch(console.error);
