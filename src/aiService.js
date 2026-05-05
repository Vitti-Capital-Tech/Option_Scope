/**
 * AI Service for Trade Analysis
 * Handles interactions with Claude (Anthropic) and Groq APIs
 */

const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY;
const GROQ_API_KEY = import.meta.env.VITE_GROQ_API_KEY;

// Using proxies defined in vite.config.js to avoid CORS
const CLAUDE_URL = '/claude/v1/messages';
const GROQ_URL = '/groq/openai/v1/chat/completions';

/**
 * Format trade data for the AI prompt with optional history for "training"
 */
const formatTradePrompt = (trade, eventType, history = []) => {
  const {
    id, underlying, type, buyLeg, sellLeg, sellQty, strikeDiff,
    entryTime, exitTime, entryBuyPrice, entrySellPrice,
    exitBuyPrice, exitSellPrice, 
    realizedGrossPnl, realizedNetPnl, 
    unrealizedGrossPnl, unrealizedNetPnl,
    totalFees, margin, exitReason
  } = trade;

  const status = eventType === 'ENTRY' ? 'NEW TRADE ENTRY' : 'TRADE EXIT / REALIZED';

  let prompt = `### IMPORTANT: ANALYZE ONLY THE "CURRENT TRADE" BELOW ###\n`;
  prompt += `### USE THE "REFERENCE" SECTION ONLY FOR CONTEXT ###\n\n`;
  
  // Include History (Memory) if available
  if (history && history.length > 0) {
    prompt += `### REFERENCE: SUCCESSFUL PAST TRADES (CONTEXT) ###\n`;
    history.forEach((past, i) => {
      prompt += `Reference Example ${i+1}: P&L: +$${past.realized_net_pnl} | Asset: ${past.underlying} | Strategy: ${past.type} | Strike Diff: ${past.strike_diff}\n`;
    });
    prompt += `\n`;
  }

  prompt += `### >>> CURRENT TRADE TO ANALYZE <<< ###
Status: ${status}
Asset: ${underlying || 'BTC'}
Strategy Type: ${type}
Buy Leg: ${buyLeg.symbol} (Strike: ${buyLeg.strike})
Sell Leg: ${sellLeg.symbol} (Strike: ${sellLeg.strike}, Qty: ${sellQty})
Strike Difference: ${strikeDiff}
-----------------------------------------
${eventType === 'ENTRY' ? `Entry Time: ${entryTime}` : `Entry Time: ${entryTime} | Exit Time: ${exitTime}`}
Entry Buy Price: ${entryBuyPrice}
Entry Sell Price: ${entrySellPrice}
${eventType === 'EXIT' ? `Exit Buy Price: ${exitBuyPrice} | Exit Sell Price: ${exitSellPrice}` : ''}
-----------------------------------------
${eventType === 'EXIT' 
    ? `FINAL REALIZED P&L:
   - Market (Gross): $${realizedGrossPnl}
   - After Fees (Net): $${realizedNetPnl}`
    : `CURRENT UNREALIZED P&L:
   - Market (Gross): $${unrealizedGrossPnl}
   - After Fees (Net): $${unrealizedNetPnl}`
}
Total Fees: $${totalFees}
Margin Used: $${margin}
${eventType === 'EXIT' ? `Exit Reason: ${exitReason}` : ''}

INSTRUCTION: 
1. Compare "Market (Gross) P&L" to see if the strategy is working. 
2. If "Market (Gross)" is positive but "After Fees (Net)" is negative, it means the trade is profitable but hasn't covered fees yet. 
3. Compare the current Strike Difference (${strikeDiff}) to the Reference examples. (Math check: is ${strikeDiff} higher or lower than references?)
4. Keep the analysis concise and strictly data-driven.
`;

  console.log("--- AI PROMPT DEBUG ---");
  console.log(prompt);
  return prompt;
};

export const getClaudeReview = async (trade, eventType, history = []) => {
  if (!ANTHROPIC_API_KEY) return 'Claude API Key missing';
  
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-latest',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: formatTradePrompt(trade, eventType, history)
        }]
      })
    });
    
    const data = await response.json().catch(() => null);
    
    if (!response.ok) {
      return `Claude Error (${response.status}): ${data?.error?.message || response.statusText}`;
    }

    if (data && data.content && data.content[0]) {
      console.log('Claude Analysis Success:', data.content[0].text);
      return data.content[0].text;
    }

    console.log('Claude Response Data:', data);
    return `Claude Error: Unexpected response format. ${data ? JSON.stringify(data) : 'No data'}`;
  } catch (error) {
    console.error('Claude API Error:', error);
    return `Claude Connection Error: ${error.message}`;
  }
};

export const getGroqReview = async (trade, eventType, history = []) => {
  if (!GROQ_API_KEY) return 'Groq API Key missing';

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role: 'user',
          content: formatTradePrompt(trade, eventType, history)
        }],
        max_tokens: 500
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return `Groq Error (${response.status}): ${data?.error?.message || response.statusText}`;
    }

    if (data && data.choices && data.choices[0]) {
      return data.choices[0].message.content;
    }

    return `Groq Error: Unexpected response format. ${data ? JSON.stringify(data) : 'No data'}`;
  } catch (error) {
    console.error('Groq API Error:', error);
    return `Groq Connection Error: ${error.message}`;
  }
};
