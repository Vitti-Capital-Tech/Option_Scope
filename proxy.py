"""
Delta Exchange CORS Proxy
--------------------------
Run this once before opening the dashboard.

Install deps (one time only):
    pip install flask flask-cors requests

Then run:
    python proxy.py

Keep this terminal open while using the dashboard.
Proxy runs on http://localhost:5555
"""

from flask import Flask, request, jsonify, Response
from flask_cors import CORS
import requests

app = Flask(__name__)
CORS(app)

DELTA_BASE = "https://api.delta.exchange"

@app.route("/v2/<path:subpath>", methods=["GET"])
def proxy(subpath):
    url = f"{DELTA_BASE}/v2/{subpath}"
    params = dict(request.args)
    print(f"→ {subpath} | {params}")
    try:
        r = requests.get(url, params=params, timeout=15,
                         headers={"Accept": "application/json"})
        print(f"  ← {r.status_code}")
        return Response(r.content, status=r.status_code,
                        content_type="application/json")
    except Exception as e:
        print(f"  ✗ {e}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/health")
def health():
    return jsonify({"status": "ok", "proxy": "Delta Exchange"})

if __name__ == "__main__":
    print("\n✅  Delta Proxy running at http://localhost:5555")
    print("    Keep this window open while using the dashboard.\n")
    app.run(host="0.0.0.0", port=5555, debug=False)
