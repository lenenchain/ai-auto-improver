require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 1. Gemini 과부하 대응 자동 재시도 함수
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

// 2. Groq API 호출 함수 (안정적인 최신 모델명 적용 및 에러 핸들링 보완)
async function callGroqAPI(promptText) {
  console.log('🤖 [단계 2] Groq API 호출 시작...');
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'openai/gpt-oss-20b',
        messages: [{ role: 'user', content: promptText }],
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000 // 20초 타임아웃 설정으로 무한 대기 방지
      }
    );

    console.log('✅ [단계 2] Groq API 호출 완료');
    
    if (response.data && response.data.choices && response.data.choices.length > 0) {
      return response.data.choices[0].message.content;
    } else {
      throw new Error('Groq API 응답 구조가 올바르지 않습니다.');
    }
  } catch (error) {
    console.error('❌ Groq API 세부 에러:', error.response?.data || error.message);
    throw new Error(`Groq API 호출 실패: ${error.response?.data?.error?.message || error.message}`);
  }
}

// 3. 두 LLM 연동 파이프라인 엔드포인트
app.post('/api/auto-pipeline', async (req, res) => {
  console.log('\n----------------------------------------');
  console.log('🚀 새로운 파이프라인 요청 접수됨');
  
  try {
    const { targetUrl } = req.body;
    console.log(`🌐 대상 URL: ${targetUrl}`);
    
    if (!targetUrl) {
      return res.status(400).json({ success: false, message: 'URL이 전달되지 않았습니다.' });
    }

    // [단계 0] 대상 웹사이트 소스 수집
    console.log('📥 [단계 0] 대상 웹사이트 HTML 수집 중...');
    let originalHtml = '';
    try {
      const siteResponse = await axios.get(targetUrl, { timeout: 10000 });
      originalHtml = siteResponse.data.substring(0, 3000);
      console.log('✅ [단계 0] HTML 수집 성공 (길이:', originalHtml.length, 'bytes)');
    } catch (scrapeErr) {
      console.error('❌ [단계 0] 웹사이트 스크래핑 실패:', scrapeErr.message);
      return res.status(400).json({ success: false, message: `대상 웹사이트를 불러오지 못했습니다: ${scrapeErr.message}` });
    }

    // [단계 1] AI A (Gemini) - 1차 소스 분석
    console.log('🤖 [단계 1] Gemini(AI A) 분석 요청 중...');
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
    console.log('✅ [단계 1] Gemini 분석 완료');

    // [단계 2] AI B (Groq) - 최종 코드 및 평가표 생성
    const groqPrompt = `
      당신은 AI B(Groq)입니다. 아래는 AI A(Gemini)가 전달한 1차 분석 및 인수인계 내용입니다:
      ${aiAOutput}

      위 내용을 바탕으로 10개 검사 기준을 모두 만족하는 최종 웹사이트 개선 코드와 평가표를 작성해주세요.
    `;
    const aiBOutput = await callGroqAPI(groqPrompt);

    // 최종 결과 반환
    console.log('🎉 모든 파이프라인 정상 완료, 클라이언트로 응답 전송');
    res.json({
      success: true,
      geminiResult: aiAOutput,
      groqResult: aiBOutput
    });

  } catch (error) {
    console.error('❌ Pipeline 에러 발생:', error.response?.data || error.message);
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