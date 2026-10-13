require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 1. Gemini 503 과부하 대응을 위한 자동 재시도 함수
async function retryWithBackoff(fn, retries = 3, delay = 1000) {
  try {
    return await fn();
  } catch (error) {
    const status = error.status || (error.response && error.response.status);
    if ((status === 503 || status === 429) && retries > 0) {
      console.warn(`⚠️ API 과부하 감지 (${status}). ${delay}ms 후 재시도합니다... (남은 횟수: ${retries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return retryWithBackoff(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

// 2. Groq API 호출 함수 (AI B 역할) - 현재 접근 권한이 확실한 표준 모델 적용
async function callGroqAPI(promptText) {
  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'openai/gpt-oss-20b', // 접근 권한 오류를 피하기 위한 표준 모델
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

// 3. 두 LLM 연동 파이프라인 엔드포인트
app.post('/api/auto-pipeline', async (req, res) => {
  try {
    const { targetUrl } = req.body;
    
    // 대상 웹사이트 소스 수집
    const siteResponse = await axios.get(targetUrl);
    const originalHtml = siteResponse.data.substring(0, 3000);

    // [단계 1] AI A (Gemini) - 1차 소스 분석 및 리포트 작성
    const geminiModel = genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });
    const geminiPrompt = `
      당신은 AI A(Gemini)입니다. 아래 웹사이트 소스를 분석하고 개선점 10가지를 정의한 뒤 1차 분석 리포트를 작성해주세요.
      원본 소스:
      ${originalHtml}
    `;

    const geminiResult = await retryWithBackoff(async () => {
      return await geminiModel.generateContent(geminiPrompt);
    });
    const aiAOutput = geminiResult.response.text();

    // [단계 2] AI B (Groq) - Gemini의 분석 리포트를 이어받아 최종 코드 및 평가표 생성
    const groqPrompt = `
      당신은 AI B(Groq)입니다. 아래는 AI A(Gemini)가 전달한 1차 분석 및 인수인계 내용입니다:
      ${aiAOutput}

      위 내용을 바탕으로 10개 검사 기준을 모두 만족하는 최종 웹사이트 개선 코드와 평가표를 작성해주세요.
    `;
    const aiBOutput = await callGroqAPI(groqPrompt);

    // 최종 결과 클라이언트에 반환
    res.json({
      success: true,
      geminiResult: aiAOutput,
      groqResult: aiBOutput
    });

  } catch (error) {
    console.error("Pipeline Error:", error.response?.data || error.message);
    res.status(500).json({ 
      success: false, 
      message: error.message, 
      details: error.response?.data || null 
    });
  }
});

app.listen(3000, () => {
  console.log('🚀 서버 실행 완료! http://localhost:3000 에 접속하세요.');
});