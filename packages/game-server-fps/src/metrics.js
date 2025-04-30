// import client from 'prom-client';

// export const register = new client.Registry();
// client.collectDefaultMetrics({ register });

// export const tickDurationHist = new client.Histogram({
//   name: 'tick_duration_ms',
//   help: 'Game loop tick duration in milliseconds',
//   buckets: [5,10,16,33,50,100]
// });
// register.registerMetric(tickDurationHist); 