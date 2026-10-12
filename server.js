require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function callGroqAPI(promptText) {
  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: promptText }]
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data.choices[0].message.content;
}

app.post('/api/auto-pipeline', async (req, res) => {
  try {
    const { targetUrl } = req.body;
    const siteResponse = await axios.get(targetUrl);
    const originalHtml = siteResponse.data.substring(0, 3000);

    const geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const geminiPrompt = `
      당신은 AI A(Gemini)입니다. 아래 웹사이트 소스를 분석하고 개선점 10가지를 정의한 뒤 1차 분석 리포트를 작성해주세요.
      원본 소스:
      ${originalHtml}
    `;
    const geminiResult = await geminiModel.generateContent(geminiPrompt);
    const aiAOutput = geminiResult.response.text();

    const grokPrompt = `
      당신은 AI B(Groq)입니다. 아래는 AI A(Gemini)가 전달한 1차 분석 및 인수인계 내용입니다:
      ${aiAOutput}

      위 내용을 바탕으로 10개 검사 기준을 모두 만족하는 최종 웹사이트 개선 코드와 평가표를 작성해주세요.
    `;
    const aiBOutput = await callGroqAPI(grokPrompt);

    res.json({
      success: true,
      geminiResult: aiAOutput,
      groqResult: aiBOutput
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.listen(3000, () => {
  console.log('🚀 서버 실행 완료! http://localhost:3000 에 접속하세요.');
});