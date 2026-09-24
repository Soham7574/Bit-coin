"""
Bitcoin Price Predictor - model training.

Steps:
 1. Load the 1-minute OHLCV data and resample it to daily candles.
 2. Build features from past prices only (lagged log returns, moving-average
    ratios, volatility) so the model can also forecast recursively into the future.
 3. Target = next day's log return. Price = today's close * exp(predicted return).
 4. Chronological split: train < 2025-01-01, test >= 2025-01-01.
 5. Compare Naive baseline, Linear Regression, Ridge and Random Forest.
 6. Save the best model and the daily data for the web app.
"""
import json
import joblib
import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression, Ridge
from sklearn.ensemble import RandomForestRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

DATA_PATH = "../DATA/bitcoin_data.csv"
SPLIT_DATE = "2025-01-01"

LAGS = [1, 2, 3, 7, 14, 30]
MA_WINDOWS = [7, 30, 90]
VOL_WINDOWS = [7, 30]


def make_features(close: pd.Series) -> pd.DataFrame:
    """Features for day t, computed only from closes up to and including day t."""
    logret = np.log(close).diff()
    f = pd.DataFrame(index=close.index)
    for lag in LAGS:
        f[f"Ret_Lag_{lag}"] = logret.shift(lag - 1)
    for w in MA_WINDOWS:
        f[f"Close_to_MA_{w}"] = close / close.rolling(w).mean() - 1
    for w in VOL_WINDOWS:
        f[f"Vol_{w}"] = logret.rolling(w).std()
    f["Mom_30"] = np.log(close / close.shift(30))
    return f


FEATURES = list(make_features(pd.Series([1.0, 2.0])).columns)


def main():
    print("Loading minute data ...")
    df = pd.read_csv(DATA_PATH)
    df["Datetime"] = pd.to_datetime(df["Timestamp"], unit="s")
    df = df.set_index("Datetime")

    daily = df.resample("D").agg(
        {"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"}
    ).dropna()
    print("Daily shape:", daily.shape)

    X = make_features(daily["Close"])
    y = np.log(daily["Close"]).diff().shift(-1).rename("Target")  # next-day log return
    data = pd.concat([X, y, daily["Close"]], axis=1).dropna()

    train = data[data.index < SPLIT_DATE]
    test = data[data.index >= SPLIT_DATE]
    print(f"Train: {train.index.min().date()} -> {train.index.max().date()} ({len(train)})")
    print(f"Test : {test.index.min().date()} -> {test.index.max().date()} ({len(test)})")

    models = {
        "Linear Regression": make_pipeline(StandardScaler(), LinearRegression()),
        "Ridge Regression": make_pipeline(StandardScaler(), Ridge(alpha=10.0)),
        "Random Forest": RandomForestRegressor(
            n_estimators=300, max_depth=6, min_samples_leaf=20, random_state=42, n_jobs=-1
        ),
    }

    actual_price = test["Close"] * np.exp(test["Target"])
    results = {}

    def score(name, pred_price):
        results[name] = {
            "MAE": float(mean_absolute_error(actual_price, pred_price)),
            "RMSE": float(np.sqrt(mean_squared_error(actual_price, pred_price))),
            "R2": float(r2_score(actual_price, pred_price)),
            "MAPE_%": float(np.mean(np.abs(actual_price - pred_price) / actual_price) * 100),
        }
        results[name]["Accuracy_%"] = 100 - results[name]["MAPE_%"]
        # Direction accuracy: did the model call the up/down move correctly? (baseline has none)
        if name != "Naive Baseline":
            results[name]["Direction_%"] = float(
                np.mean(np.sign(pred_price - test["Close"]) == np.sign(actual_price - test["Close"])) * 100
            )

    score("Naive Baseline", test["Close"])
    for name, m in models.items():
        m.fit(train[FEATURES], train["Target"])
        score(name, test["Close"] * np.exp(m.predict(test[FEATURES])))

    res = pd.DataFrame(results).T
    print("\nTest-set results (next-day close price):")
    print(res.round(3))

    best_name = res.drop("Naive Baseline")["MAE"].idxmin()
    print(f"\nBest model: {best_name}")

    # Refit best model on all data for deployment
    best = models[best_name]
    bt_pred = test["Close"] * np.exp(best.predict(test[FEATURES]))
    bt_dates = (test.index + pd.Timedelta(days=1)).strftime("%Y-%m-%d").tolist()
    with open("backtest.json", "w") as fp:
        json.dump({"dates": bt_dates, "actual": actual_price.round(2).tolist(),
                   "predicted": bt_pred.round(2).tolist()}, fp)

    best.fit(data[FEATURES], data["Target"])
    resid_std = float(np.std(data["Target"] - best.predict(data[FEATURES])))

    joblib.dump(best, "model.pkl")
    daily[["Open", "High", "Low", "Close", "Volume"]].to_csv("daily_data.csv")
    with open("model_info.json", "w") as fp:
        json.dump(
            {
                "best_model": best_name,
                "features": FEATURES,
                "resid_std": resid_std,
                "last_date": str(daily.index.max().date()),
                "results": results,
            },
            fp,
            indent=2,
        )
    print("Saved model.pkl, daily_data.csv, model_info.json")


if __name__ == "__main__":
    main()
