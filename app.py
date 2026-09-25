"""Bitcoin Price Predictor - Flask web app. Run: python app.py -> http://127.0.0.1:5000"""
import json
import joblib
import numpy as np
import pandas as pd
from flask import Flask, jsonify, render_template, request

from train_model import make_features, LAGS, MA_WINDOWS, VOL_WINDOWS

app = Flask(__name__)

info = json.load(open("model_info.json"))
FEATURES = info["features"]
DEFAULT_MODEL = info["default_model"]
# The three selectable models: Random Forest (default), Ridge Regression, Linear Regression
MODELS = {key: joblib.load(f"models/{key}.pkl") for key in info["models"]}
for m in MODELS.values():
    if hasattr(m, "n_jobs"):
        m.n_jobs = 1  # small predictions are faster without worker threads
RESID_STD = {key: m["resid_std"] for key, m in info["models"].items()}

daily = pd.read_csv("daily_data.csv", index_col=0, parse_dates=True)
close = daily["Close"]
FIRST_DATE = close.index.min() + pd.Timedelta(days=91)  # need 90 days of history for features
LAST_DATE = close.index.max()
MAX_HORIZON = 365
N_SIMS = 100
WINDOW = 91  # closes needed to build one feature row
# Shock size for simulations: last year's daily log-return volatility (early-era Bitcoin
# was far more volatile, so the all-history residual std would exaggerate the spread)
RECENT_VOL = float(np.log(close).diff().iloc[-365:].std())


def fmt(ts):
    return ts.strftime("%Y-%m-%d")


def predict_next(model, history: pd.Series) -> float:
    """Predict the close price for the day after the last day in `history`."""
    feats = make_features(history.iloc[-120:]).iloc[[-1]][FEATURES]
    return float(history.iloc[-1] * np.exp(model.predict(feats)[0]))


def batch_features(paths: np.ndarray) -> pd.DataFrame:
    """Same features as make_features(), for the last day of many price paths at once.
    paths: (n_paths, >= WINDOW) array of closes."""
    p = paths[:, -WINDOW:]
    r = np.diff(np.log(p), axis=1)
    f = {}
    for lag in LAGS:
        f[f"Ret_Lag_{lag}"] = r[:, -lag]
    for w in MA_WINDOWS:
        f[f"Close_to_MA_{w}"] = p[:, -1] / p[:, -w:].mean(axis=1) - 1
    for w in VOL_WINDOWS:
        f[f"Vol_{w}"] = r[:, -w:].std(axis=1, ddof=1)
    f["Mom_30"] = np.log(p[:, -1] / p[:, -31])
    return pd.DataFrame(f)[FEATURES]


def simulate(model, horizon: int, seed: int = 7) -> np.ndarray:
    """Monte Carlo forecast: at each step the model predicts the expected return for every
    path, then a random shock drawn from a fat-tailed Student-t (df=4) scaled to
    recent daily volatility is added. Returns (N_SIMS, horizon) simulated closes."""
    rng = np.random.default_rng(seed)
    base = close.values[-WINDOW:]
    paths = np.tile(base, (N_SIMS, 1))
    out = np.empty((N_SIMS, horizon))
    scale = RECENT_VOL / np.sqrt(2.0)  # t(4) has variance 2
    for h in range(horizon):
        mu = model.predict(batch_features(paths))
        shock = rng.standard_t(4, N_SIMS) * scale
        nxt = paths[:, -1] * np.exp(mu + shock)
        paths = np.column_stack([paths[:, 1:], nxt])
        out[:, h] = nxt
    return out


def series(s: pd.Series):
    return {"dates": [fmt(d) for d in s.index], "prices": s.round(2).tolist()}


@app.route("/")
def index():
    return render_template("index.html", first=fmt(FIRST_DATE), last=fmt(LAST_DATE))


@app.route("/api/meta")
def meta():
    weekly = close.resample("W").last().dropna()
    models = {k: {kk: vv for kk, vv in m.items() if kk != "resid_std"} for k, m in info["models"].items()}
    return jsonify(
        default_model=DEFAULT_MODEL, models=models, model_order=list(info["models"]),
        backtest_dates=info["backtest"]["dates"], backtest_actual=info["backtest"]["actual"],
        split=info["split"], last_date=fmt(LAST_DATE), first_date=fmt(FIRST_DATE),
        last_close=float(close.iloc[-1]), n_days=int(len(close)), weekly=series(weekly),
    )


@app.route("/predict")
def predict():
    key = request.args.get("model", DEFAULT_MODEL)
    if key not in MODELS:
        return jsonify(error="Unknown model. Choose Random Forest, Ridge Regression or Linear Regression."), 400
    model, name = MODELS[key], info["models"][key]["name"]

    try:
        when = pd.to_datetime(request.args.get("datetime", ""))
    except Exception:
        return jsonify(error="Invalid date/time."), 400
    day = when.normalize()

    if day < FIRST_DATE:
        return jsonify(error=f"Please pick a date on or after {fmt(FIRST_DATE)}."), 400
    if (day - LAST_DATE).days > MAX_HORIZON:
        return jsonify(error=f"Forecasts are limited to {MAX_HORIZON} days after {fmt(LAST_DATE)}."), 400

    if day <= LAST_DATE:
        # Historical date: one-day-ahead prediction using only data before that day
        pred = predict_next(model, close[close.index < day])
        actual = float(close.loc[day])
        hist = close[(close.index >= day - pd.Timedelta(days=60)) & (close.index <= day + pd.Timedelta(days=20))]
        band = 1.645 * RESID_STD[key]
        return jsonify(
            mode="historical", model=key, model_name=name, date=fmt(day), predicted=pred, actual=actual,
            error_pct=abs(pred - actual) / actual * 100,
            low=pred * np.exp(-band), high=pred * np.exp(band),
            history=series(hist),
        )

    # Future date: Monte Carlo simulation driven by the chosen model
    horizon = (day - LAST_DATE).days
    sims = simulate(model, horizon)
    dates = [fmt(LAST_DATE + pd.Timedelta(days=i + 1)) for i in range(horizon)]
    q = {k: np.percentile(sims, v, axis=0).round(2).tolist()
         for k, v in {"p5": 5, "p25": 25, "p50": 50, "p75": 75, "p95": 95}.items()}
    final = sims[:, -1]
    last = float(close.iloc[-1])
    return jsonify(
        mode="future", model=key, model_name=name, date=fmt(day), horizon=horizon, last_actual=last,
        last_date=fmt(LAST_DATE),
        predicted=float(np.median(final)), low=float(np.percentile(final, 5)), high=float(np.percentile(final, 95)),
        prob_up=float(np.mean(final > last) * 100),
        history=series(close.iloc[-120:]),
        forecast={"dates": dates, **q, "samples": sims[:6].round(2).tolist()},
    )


if __name__ == "__main__":
    app.run(debug=True)
