# backend/app/routers/ml_utils.py
import warnings
import numpy as np

warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", message=".*convergence.*", category=RuntimeWarning)
warnings.filterwarnings("ignore")


def arima_forecast(values, forecast_steps=5, test_size=None):
    """
    Fits a real ARIMA model on a time series and returns:
      - forecast: list of future predicted values
      - rmse, mae: real accuracy metrics from a train/test holdout split
      - order: the (p,d,q) ARIMA order actually used

    values: list of floats, in chronological order (oldest first)
    forecast_steps: how many future periods to predict
    test_size: how many of the most recent real points to hold out for
               validation (defaults to ~20% of the series, min 1, max 3)
    """
    from statsmodels.tsa.arima.model import ARIMA

    values = [v for v in values if v is not None]
    n = len(values)

    if n < 4:
        return _fallback_linear(values, forecast_steps)

    if test_size is None:
        test_size = max(1, min(3, n // 5))

    train = values[: n - test_size]
    test = values[n - test_size :]

    order_candidates = [(1, 1, 1), (1, 1, 0), (0, 1, 1), (1, 0, 0)]
    best_model = None
    best_order = None
    for order in order_candidates:
        try:
            model = ARIMA(train, order=order).fit()
            best_model = model
            best_order = order
            break
        except Exception:
            continue

    if best_model is None:
        return _fallback_linear(values, forecast_steps)

    try:
        test_forecast = best_model.forecast(steps=len(test))
        rmse = float(np.sqrt(np.mean((np.array(test) - np.array(test_forecast)) ** 2)))
        mae = float(np.mean(np.abs(np.array(test) - np.array(test_forecast))))
    except Exception:
        rmse, mae = None, None

    try:
        full_model = ARIMA(values, order=best_order).fit()
        forecast = full_model.forecast(steps=forecast_steps)
        forecast = [round(float(f), 3) for f in forecast]
    except Exception:
        return _fallback_linear(values, forecast_steps)

    return {
        "forecast": forecast,
        "rmse": round(rmse, 3) if rmse is not None else None,
        "mae": round(mae, 3) if mae is not None else None,
        "order": best_order,
        "method": "ARIMA",
    }


def sarima_forecast(values, forecast_steps=24, seasonal_period=12, test_size=None):
    """
    Fits SARIMA — ARIMA plus a seasonal term — for series with a strong
    yearly cycle (temperature is the clear case). Falls back to plain
    ARIMA if there isn't enough history for a real seasonal fit.
    """
    from statsmodels.tsa.statespace.sarimax import SARIMAX

    values = [v for v in values if v is not None]
    n = len(values)

    if n < seasonal_period * 2:
        return arima_forecast(values, forecast_steps=forecast_steps, test_size=test_size)

    if test_size is None:
        test_size = min(seasonal_period * 2, max(1, n // 5))

    train = values[: n - test_size]
    test = values[n - test_size :]

    order = (1, 1, 1)
    seasonal_order = (1, 1, 1, seasonal_period)

    try:
        model = SARIMAX(
            train, order=order, seasonal_order=seasonal_order,
            enforce_stationarity=False, enforce_invertibility=False,
        ).fit(disp=False)
    except Exception:
        return arima_forecast(values, forecast_steps=forecast_steps, test_size=test_size)

    try:
        test_forecast = model.forecast(steps=len(test))
        rmse = float(np.sqrt(np.mean((np.array(test) - np.array(test_forecast)) ** 2)))
        mae = float(np.mean(np.abs(np.array(test) - np.array(test_forecast))))
    except Exception:
        rmse, mae = None, None

    try:
        full_model = SARIMAX(
            values, order=order, seasonal_order=seasonal_order,
            enforce_stationarity=False, enforce_invertibility=False,
        ).fit(disp=False)
        forecast = full_model.forecast(steps=forecast_steps)
        forecast = [round(float(f), 3) for f in forecast]
    except Exception:
        return arima_forecast(values, forecast_steps=forecast_steps, test_size=test_size)

    return {
        "forecast": forecast,
        "rmse": round(rmse, 3) if rmse is not None else None,
        "mae": round(mae, 3) if mae is not None else None,
        "order": f"{order}{seasonal_order}",
        "method": "SARIMA",
    }


def expanding_window_validation(values, years, min_train=4):
    """
    Chronological expanding-window validation for ARIMA — the correct way
    to validate a time-series model. Never shuffles the data, never uses
    future information to train on past years.

    For each test point (after enough training history), we:
      1. Take all data up to (but NOT including) the test year as training.
      2. Fit ARIMA on that training window alone.
      3. Forecast exactly 1 step ahead.
      4. Compare that forecast against the real held-out value.
      5. Move the window forward by one year and repeat.

    Returns a dict with:
      - validation_rows: list of {train_start, train_end, test_year,
          actual, predicted, abs_error, pct_error}
      - mae, rmse, mape: overall metrics across all validation predictions
      - final_forecast_year: the year after the last historical point
      - final_forecast_value: ARIMA forecast using ALL historical data
      - order: ARIMA order used
    """
    from statsmodels.tsa.arima.model import ARIMA

    values = [v for v in values if v is not None]
    n = len(values)

    if n < min_train + 1:
        return None   # not enough data for even one validation step

    order_candidates = [(1, 1, 1), (1, 1, 0), (0, 1, 1), (1, 0, 0)]

    def _fit_and_forecast(train_vals):
        import warnings
        warnings.filterwarnings("ignore")
        for order in order_candidates:
            try:
                model = ARIMA(train_vals, order=order).fit()
                fc = float(model.forecast(steps=1)[0])
                return fc, order
            except Exception:
                continue
        # Final fallback: linear trend
        if len(train_vals) >= 2:
            trend = train_vals[-1] - train_vals[-2]
            return float(train_vals[-1] + trend), None
        return float(train_vals[-1]), None

    rows = []
    best_order = None

    # Expanding window: train on [0..i-1], test on [i]
    for i in range(min_train, n):
        train_vals = values[:i]
        actual = values[i]
        train_years = years[:i]
        test_year = years[i]

        predicted, order = _fit_and_forecast(train_vals)
        if best_order is None and order is not None:
            best_order = order

        abs_err = abs(actual - predicted)
        pct_err = (abs_err / actual * 100) if actual != 0 else None

        rows.append({
            "train_start": int(train_years[0]),
            "train_end": int(train_years[-1]),
            "test_year": int(test_year),
            "actual": round(float(actual), 1),
            "predicted": round(float(predicted), 1),
            "abs_error": round(float(abs_err), 1),
            "pct_error": round(float(pct_err), 2) if pct_err is not None else None,
        })

    if not rows:
        return None

    actuals = np.array([r["actual"] for r in rows])
    predicted_arr = np.array([r["predicted"] for r in rows])
    errors = np.abs(actuals - predicted_arr)

    mae = float(np.mean(errors))
    rmse = float(np.sqrt(np.mean(errors ** 2)))
    mape_vals = [(abs(a - p) / a * 100) for a, p in zip(actuals, predicted_arr) if a != 0]
    mape = float(np.mean(mape_vals)) if mape_vals else None

    # Final model: fit on ALL available historical data, forecast 1 step ahead
    final_fc, _ = _fit_and_forecast(values)
    final_year = int(years[-1]) + 1

    return {
        "validation_rows": rows,
        "mae": round(mae, 1),
        "rmse": round(rmse, 1),
        "mape": round(mape, 2) if mape is not None else None,
        "order": best_order,
        "final_forecast_year": final_year,
        "final_forecast_value": round(final_fc, 1),
        "method": "ARIMA",
        "n_train_total": n,
        "n_validation_steps": len(rows),
    }



    """Honest fallback when there isn't enough real data for ARIMA — a simple
    trend projection, clearly labeled as such rather than disguised as ARIMA."""
    if len(values) < 2:
        last = values[-1] if values else 0
        return {
            "forecast": [round(last, 3)] * forecast_steps,
            "rmse": None, "mae": None, "order": None, "method": "insufficient_data",
        }
    growth = (values[-1] - values[0]) / max(len(values) - 1, 1)
    forecast = [round(values[-1] + growth * (i + 1), 3) for i in range(forecast_steps)]
    return {"forecast": forecast, "rmse": None, "mae": None, "order": None, "method": "linear_fallback"}