// engine/feedback_optimizer.js - Continuous Learning & Self-Optimizing Model Calibration
const fs = require("fs");
const path = require("path");
const { getCompletedTrades } = require("./trade_logger");
const { loadWeights } = require("./predictive_engine");

const WEIGHTS_PATH = path.join(__dirname, "..", "data", "model_weights.json");

function optimizeWeightsFromHistory() {
  const trades = getCompletedTrades();
  if (!trades || trades.length === 0) {
    return { success: false, message: "No completed trades available to optimize from." };
  }

  const model = loadWeights();
  const lr = model.learning_rate || 0.05;
  const reg = model.l2_regularization || 0.001;
  let totalLoss = 0;
  let updatedCount = 0;

  for (const trade of trades) {
    if (!trade.features || trade.predictedProbability === null) continue;
    const y = trade.isWin ? 1.0 : 0.0;
    const yHat = trade.predictedProbability;
    const error = y - yHat;

    // Cross-Entropy Loss
    const loss = -(y * Math.log(Math.max(1e-5, yHat)) + (1 - y) * Math.log(Math.max(1e-5, 1 - yHat)));
    totalLoss += loss;

    // Stochastic Gradient Descent updates with L2 Regularization
    for (const [featKey, featVal] of Object.entries(trade.features)) {
      if (model.features[featKey] !== undefined) {
        const grad = error * featVal;
        model.features[featKey] = Number(((1 - reg) * model.features[featKey] + lr * grad).toFixed(5));
      }
    }
    model.bias = Number((model.bias + lr * error).toFixed(5));
    updatedCount++;
  }

  model.last_updated = new Date().toISOString();
  model.total_trades_learned = (model.total_trades_learned || 0) + updatedCount;
  fs.writeFileSync(WEIGHTS_PATH, JSON.stringify(model, null, 2), "utf8");

  const avgLoss = updatedCount > 0 ? (totalLoss / updatedCount).toFixed(4) : 0;
  console.log("[FEEDBACK OPTIMIZER] Successfully calibrated weights from " + updatedCount + " trades. Avg Loss: " + avgLoss);
  return {
    success: true,
    updatedTrades: updatedCount,
    averageLoss: Number(avgLoss),
    newWeights: model.features
  };
}

module.exports = { optimizeWeightsFromHistory };
