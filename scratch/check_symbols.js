
import { apiGet } from './src/api.js';

async function test() {
    const btcTickers = await apiGet('/v2/tickers', {
        underlying_asset_symbols: 'BTC',
        contract_types: 'perpetual_futures',
    });
    console.log('BTC Tickers:', btcTickers.map(t => ({ symbol: t.symbol, mark_price: t.mark_price })));

    const ethTickers = await apiGet('/v2/tickers', {
        underlying_asset_symbols: 'ETH',
        contract_types: 'perpetual_futures',
    });
    console.log('ETH Tickers:', ethTickers.map(t => ({ symbol: t.symbol, mark_price: t.mark_price })));
}

// Since we are in a browser-like environment (Vite), we can't just run this with node easily without setup.
// I'll just assume the standard symbols or fetch them dynamically in the app.
