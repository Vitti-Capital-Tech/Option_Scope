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
* Python 3
* Flask and Requests libraries for Python

### Steps

1. Install backend dependencies:
   ```bash
   pip install flask requests
   ```

2. Install frontend dependencies:
   ```bash
   npm install
   ```

3. Set up environment variables:
   Copy `.env.example` to a new file named `.env` and add your Delta Exchange credentials.

4. Start the local proxy server (Terminal 1):
   ```bash
   python proxy.py
   ```

5. Start the frontend development server (Terminal 2):
   ```bash
   npm run dev
   ```

6. Open the provided localhost URL in your browser to access the dashboard.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.