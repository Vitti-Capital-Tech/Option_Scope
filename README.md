# OptionScope

OptionScope is a real-time monitoring dashboard for options contracts on Delta Exchange. It provides a clean, responsive interface to view live mark prices and combined premiums for call and put options.

## Overview

The application allows traders to select an underlying asset, expiry date, and strike price to generate real-time candlestick charts. It displays the individual call and put option charts alongside a combined premium chart, providing immediate insight into the total cost of straddle or strangle positions.

The project consists of two main parts:
1. A React frontend that renders the user interface and high-performance charts.
2. A Python proxy server that facilitates secure communication with the Delta Exchange API.

## Documentation

Detailed architectural documentation is available in the `docs` folder:

* [High Level Design (HLD)](docs/HLD.md) - A non-technical overview of the system components and data flow.
* [Low Level Design (LLD)](docs/LLD.md) - Technical implementation details, including React state management and WebSocket integration.

## Installation and Setup

### Prerequisites
* Node.js

### Steps

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Open the provided localhost URL in your browser to access the dashboard.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.