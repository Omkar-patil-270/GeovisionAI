{validation?.validation_rows?.length > 0 && (
  <>
    <div className="pop-section-title">
      📊 Expanding-Window Validation (ARIMA)
    </div>
    <div className="pop-validation-note">
      Each row trains ARIMA from the first data year up to the
      training end year, then forecasts exactly ONE year ahead.
      The model never uses future data during training.
    </div>

    <div style={{ overflowX: "auto" }}>
      <table className="pop-table pop-val-table">
        <thead>
          <tr>
            <th>Training Period</th>
            <th>Test Year</th>
            <th>Actual Population</th>
            <th>Predicted Population</th>
            <th>Absolute Error</th>
            <th>MAE</th>
            <th>RMSE</th>
            <th>MAPE</th>
          </tr>
        </thead>
        <tbody>
          {validation.validation_rows.map((r, i) => {
            const runningActuals = validation.validation_rows
              .slice(0, i + 1).map(x => x.actual);
            const runningPreds   = validation.validation_rows
              .slice(0, i + 1).map(x => x.predicted);
            const runningErrors  = runningActuals.map(
              (a, j) => Math.abs(a - runningPreds[j])
            );
            const rowMae  = runningErrors.reduce((a,b)=>a+b,0)
                            / runningErrors.length;
            const rowRmse = Math.sqrt(
              runningErrors.map(e=>e*e).reduce((a,b)=>a+b,0)
              / runningErrors.length
            );
            const mapeVals = runningActuals
              .map((a,j) => Math.abs(a-runningPreds[j])/a*100)
              .filter(v => isFinite(v));
            const rowMape = mapeVals.length
              ? mapeVals.reduce((a,b)=>a+b,0)/mapeVals.length
              : null;

            return (
              <tr key={i}>
                <td>{r.train_start}–{r.train_end}</td>
                <td><b>{r.test_year}</b></td>
                <td>{fmtPop(r.actual)}</td>
                <td style={{ color }}>{fmtPop(r.predicted)}</td>
                <td className="err-cell">{fmtPop(r.abs_error)}</td>
                <td>{fmtPop(Math.round(rowMae))}</td>
                <td>{fmtPop(Math.round(rowRmse))}</td>
                <td className={
                  rowMape == null ? "" :
                  rowMape < 5  ? "err-cell good" :
                  rowMape < 15 ? "err-cell ok" :
                                 "err-cell bad"
                }>
                  {rowMape != null
                    ? `${rowMape.toFixed(2)}%`
                    : "—"}
                </td>
              </tr>
            );
          })}

          {/* Overall summary row */}
          <tr style={{
            fontWeight: 700,
            borderTop: "2px solid rgba(255,255,255,0.2)"
          }}>
            <td colSpan={2}>Overall ({validation.n_validation_steps} steps)</td>
            <td>—</td>
            <td>—</td>
            <td>—</td>
            <td style={{ color: "#00d4ff" }}>
              {fmtPop(Math.round(validation.mae))}
            </td>
            <td style={{ color: "#00d4ff" }}>
              {fmtPop(Math.round(validation.rmse))}
            </td>
            <td style={{ color: "#00d4ff" }}>
              {validation.mape != null
                ? `${validation.mape.toFixed(2)}%`
                : "—"}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    {/* Overall metrics boxes */}
    <div className="pop-metrics-row">
      <div className="pop-metric-box">
        <div className="pop-metric-label">MAE</div>
        <div className="pop-metric-val">
          {fmtPop(Math.round(validation.mae))}
        </div>
        <div className="pop-metric-desc">Mean Absolute Error</div>
      </div>
      <div className="pop-metric-box">
        <div className="pop-metric-label">RMSE</div>
        <div className="pop-metric-val">
          {fmtPop(Math.round(validation.rmse))}
        </div>
        <div className="pop-metric-desc">Root Mean Squared Error</div>
      </div>
      <div className="pop-metric-box">
        <div className="pop-metric-label">MAPE</div>
        <div className="pop-metric-val">
          {validation.mape != null
            ? `${validation.mape.toFixed(2)}%`
            : "—"}
        </div>
        <div className="pop-metric-desc">Mean Abs % Error</div>
      </div>
    </div>

    <div className="pop-section-title">
      📈 Actual vs Predicted (Validation Years)
    </div>
    <ActualVsPredictedChart
      rows={validation.validation_rows}
      color={color}
    />
  </>
)}