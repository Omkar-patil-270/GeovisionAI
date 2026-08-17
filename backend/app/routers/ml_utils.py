def expanding_window_validation(values, years, min_train=5):
    """
    Chronological expanding-window validation for ARIMA.
    Always trains from the FIRST data point, expands one year at a time.

    Example with data 2015-2020 and min_train=5:
      TRAIN 2015-2019 → TEST 2020
    
    Example with data 2015-2025 and min_train=5:
      TRAIN 2015-2019 → TEST 2020
      TRAIN 2015-2020 → TEST 2021
      TRAIN 2015-2021 → TEST 2022
      TRAIN 2015-2022 → TEST 2023
      TRAIN 2015-2023 → TEST 2024
      TRAIN 2015-2024 → TEST 2025
    """
    import warnings
    warnings.filterwarnings("ignore")
    from statsmodels.tsa.arima.model import ARIMA

    values = [v for v in values if v is not None]
    years = list(years)
    n = len(values)

    if n < min_train + 1:
        return None  # not enough data for even one validation step

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
        # linear trend fallback
        if len(train_vals) >= 2:
            trend = train_vals[-1] - train_vals[-2]
            return float(train_vals[-1] + trend), None
        return float(train_vals[-1]), None

    rows = []
    best_order = None

    # Expanding window — always train from index 0
    for i in range(min_train, n):
        train_vals = values[:i]        # e.g. 2015-2019 (5 points)
        actual = values[i]             # e.g. 2020
        train_years = years[:i]
        test_year = years[i]

        predicted, order = _fit_and_forecast(train_vals)
        if best_order is None and order is not None:
            best_order = order

        abs_err = abs(actual - predicted)
        pct_err = (abs_err / actual * 100) if actual != 0 else None

        rows.append({
            "train_start": int(train_years[0]),
            "train_end":   int(train_years[-1]),
            "test_year":   int(test_year),
            "actual":      round(float(actual), 1),
            "predicted":   round(float(predicted), 1),
            "abs_error":   round(float(abs_err), 1),
            "pct_error":   round(float(pct_err), 2) if pct_err is not None else None,
        })

    if not rows:
        return None

    actuals       = np.array([r["actual"]    for r in rows])
    predicted_arr = np.array([r["predicted"] for r in rows])
    errors        = np.abs(actuals - predicted_arr)

    mae  = float(np.mean(errors))
    rmse = float(np.sqrt(np.mean(errors ** 2)))
    mape_vals = [
        abs(a - p) / a * 100
        for a, p in zip(actuals, predicted_arr) if a != 0
    ]
    mape = float(np.mean(mape_vals)) if mape_vals else None

    # Final model: train on ALL data, forecast next year
    final_fc, _ = _fit_and_forecast(values)
    final_year   = int(years[-1]) + 1

    return {
        "validation_rows":       rows,
        "mae":                   round(mae, 1),
        "rmse":                  round(rmse, 1),
        "mape":                  round(mape, 2) if mape is not None else None,
        "order":                 best_order,
        "final_forecast_year":   final_year,
        "final_forecast_value":  round(final_fc, 1),
        "method":                "ARIMA",
        "n_train_total":         n,
        "n_validation_steps":    len(rows),
    }