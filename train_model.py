"""
Bitcoin Price Predictor - model training.

Steps:
 1. Load the 1-minute OHLCV data and resample it to daily candles.
 2. Build features from past prices only (lagged log returns, moving-average
    ratios, volatility) so the model can also forecast recursively into the future.
 3. Target = next day's log return. Price = today's close * exp(predicted return).
 4. Chronological split: train < 2025-01-01, test >= 2025-01-01.
 5. Train the three web-app models (Random Forest, Ridge Regression, Linear Regression),
    evaluate each on the test period and with 5-fold time-series cross-validation.
 6. Refit each model on all data and save it to models/<key>.pkl, plus model_info.json
    (metrics and chart data for the website) and daily_data.csv.
"""
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression, Ridge
from sklearn.ensemble import RandomForestRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import (mean_absolute_error, mean_squared_error, r2_score, accuracy_score,
                             precision_score, recall_score, f1_score, confusion_matrix, roc_curve,
                             roc_auc_score)

DATA_PATH = "../DATA/bitcoin_data.csv"
SPLIT_DATE = "2025-01-01"

LAGS = [1, 2, 3, 7, 14, 30]
MA_WINDOWS = [7, 30, 90]
VOL_WINDOWS = [7, 30]

# The three models offered in the web app (key -> display name). Random Forest is the default.
MODEL_NAMES = {"random_forest": "Random Forest", "ridge": "Ridge Regression", "linear": "Linear Regression"}
DEFAULT_MODEL = "random_forest"


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


def build_model(key):
    if key == "random_forest":
        return RandomForestRegressor(n_estimators=300, max_depth=6, min_samples_leaf=20, random_state=42, n_jobs=-1)
    if key == "ridge":
        return make_pipeline(StandardScaler(), Ridge(alpha=10.0))
    return make_pipeline(StandardScaler(), LinearRegression())


def fit_status(train_r2, test_r2):
    """Label the fit from train/test R² on next-day returns (same rule as the notebook)."""
    gap = train_r2 - test_r2
    if train_r2 < 0.05:
        return "Underfitting"
    if gap > 0.20:
        return "Overfitting"
    if gap > 0.05:
        return "Mild overfitting"
    return "Good fit"


def feature_importance(model):
    """Random Forest: impurity importance. Linear models: share of |standardised coefficient|."""
    if hasattr(model, "feature_importances_"):
        imp = model.feature_importances_
    else:
        imp = np.abs(model[-1].coef_)
        imp = imp / imp.sum()
    order = np.argsort(imp)[::-1]
    return {"features": [FEATURES[i] for i in order], "importance": [round(float(imp[i]), 5) for i in order]}


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

    actual_price = test["Close"] * np.exp(test["Target"])
    up_test = (test["Target"] > 0).astype(int)
    bt_dates = (test.index + pd.Timedelta(days=1)).strftime("%Y-%m-%d").tolist()
    tscv = TimeSeriesSplit(n_splits=5)
    Path("models").mkdir(exist_ok=True)

    out = {}
    for key, name in MODEL_NAMES.items():
        model = build_model(key)
        model.fit(train[FEATURES], train["Target"])
        pred_tr = model.predict(train[FEATURES])
        pred_te = model.predict(test[FEATURES])
        pred_price = test["Close"] * np.exp(pred_te)
        up_pred = (pred_te > 0).astype(int)

        # 5-fold time-series cross-validation on the training period
        cv_dir, cv_mae = [], []
        for tr_idx, va_idx in tscv.split(train):
            m = build_model(key).fit(train[FEATURES].iloc[tr_idx], train["Target"].iloc[tr_idx])
            p = m.predict(train[FEATURES].iloc[va_idx])
            yv = train["Target"].iloc[va_idx]
            cv_dir.append(float(accuracy_score(yv > 0, p > 0)))
            cv_mae.append(float(mean_absolute_error(yv, p)))

        fpr, tpr, _ = roc_curve(up_test, pred_te)
        idx = np.unique(np.linspace(0, len(fpr) - 1, min(60, len(fpr))).astype(int))
        train_r2, test_r2 = r2_score(train["Target"], pred_tr), r2_score(test["Target"], pred_te)
        mape = float(np.mean(np.abs(actual_price - pred_price) / actual_price) * 100)

        out[key] = {
            "name": name,
            "metrics": {
                "MAE": float(mean_absolute_error(actual_price, pred_price)),
                "RMSE": float(np.sqrt(mean_squared_error(actual_price, pred_price))),
                "R2": float(r2_score(actual_price, pred_price)),
                "MAPE_%": mape,
                "Accuracy_%": 100 - mape,
                "Direction_%": float(accuracy_score(up_test, up_pred) * 100),
                "Precision": float(precision_score(up_test, up_pred, zero_division=0)),
                "Recall": float(recall_score(up_test, up_pred, zero_division=0)),
                "F1": float(f1_score(up_test, up_pred, zero_division=0)),
                "AUC": float(roc_auc_score(up_test, pred_te)),
                "Train_R2_return": float(train_r2),
                "Test_R2_return": float(test_r2),
                "Fit_Status": fit_status(train_r2, test_r2),
                "CV_Direction_mean": float(np.mean(cv_dir)),
                "CV_MAE_mean": float(np.mean(cv_mae)),
                "CV_MAE_std": float(np.std(cv_mae)),
            },
            "cv_folds": {"dir_acc": cv_dir, "mae": cv_mae},
            "roc": {"fpr": fpr[idx].round(4).tolist(), "tpr": tpr[idx].round(4).tolist()},
            "confusion_matrix": confusion_matrix(up_test, up_pred).tolist(),  # [[TN, FP], [FN, TP]]
            "feature_importance": feature_importance(model),
            "backtest": pred_price.round(2).tolist(),
        }

        # Refit on all data for deployment
        model.fit(data[FEATURES], data["Target"])
        out[key]["resid_std"] = float(np.std(data["Target"] - model.predict(data[FEATURES])))
        joblib.dump(model, f"models/{key}.pkl")
        mt = out[key]["metrics"]
        print(f"{name:<18} MAE ${mt['MAE']:,.0f}  acc {mt['Accuracy_%']:.2f}%  dir {mt['Direction_%']:.1f}%  "
              f"CV MAE {mt['CV_MAE_mean']:.5f}  {mt['Fit_Status']}")

    daily[["Open", "High", "Low", "Close", "Volume"]].to_csv("daily_data.csv")
    with open("model_info.json", "w") as fp:
        json.dump({
            "default_model": DEFAULT_MODEL,
            "features": FEATURES,
            "last_date": str(daily.index.max().date()),
            "split": {"train_start": str(train.index.min().date()), "test_start": str(test.index.min().date()),
                      "n_train": len(train), "n_test": len(test)},
            "backtest": {"dates": bt_dates, "actual": actual_price.round(2).tolist()},
            "models": out,
        }, fp, indent=1)
    print("Saved models/*.pkl, daily_data.csv, model_info.json")


if __name__ == "__main__":
    main()
