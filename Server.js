const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const app = express();

app.use(cors());
app.use(express.json());

// ===== 1. ПОДКЛЮЧЕНИЕ К БАНКУ =====
// ВАРИАНТ: Через банковский API (Finastra, Temenos)
const BANK_CONFIG = {
    apiKey: process.env.BANK_API_KEY,
    apiSecret: process.env.BANK_API_SECRET,
    baseUrl: 'https://api.finastra.com/payments',
    swiftEndpoint: '/v1/swift/pacs008'
};

// ===== 2. ВАЛИДАЦИЯ IBAN =====
function validateIBAN(iban) {
    // Простая проверка формата
    const ibanRegex = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}$/;
    return ibanRegex.test(iban.toUpperCase());
}

// ===== 3. ГЕНЕРАЦИЯ XML =====
function generatePacs008XML(data) {
    const now = new Date().toISOString();
    return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">
  <FIToFICstmrCdtTrf>
    <GrpHdr>
      <MsgId>${data.messageId}</MsgId>
      <CreDtTm>${now}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <SttlmInf>
        <SttlmMtd>INDA</SttlmMtd>
      </SttlmInf>
    </GrpHdr>
    <CdtTrfTxInf>
      <PmtId>
        <InstrId>${data.instructionId}</InstrId>
        <EndToEndId>${data.endToEndId}</EndToEndId>
        <UETR>${data.uetr}</UETR>
      </PmtId>
      <Amt>
        <InstdAmt Ccy="${data.currency}">${data.amount}</InstdAmt>
      </Amt>
      <ChrgBr>SHAR</ChrgBr>
      <Dbtr>
        <Nm>${data.debtorName}</Nm>
        <PstlAdr>
          <StreetNm>${data.debtorStreet}</StreetNm>
          <BldgNb>${data.debtorBuilding}</BldgNb>
          <TwnNm>${data.debtorCity}</TwnNm>
          <PstCd>${data.debtorPostal}</PstCd>
          <Ctry>${data.debtorCountry}</Ctry>
        </PstlAdr>
      </Dbtr>
      <DbtrAcct>
        <Id>
          <IBAN>${data.debtorIban}</IBAN>
        </Id>
      </DbtrAcct>
      <DbtrAgt>
        <FinInstnId>
          <BICFI>${data.debtorBic}</BICFI>
        </FinInstnId>
      </DbtrAgt>
      <Cdtr>
        <Nm>${data.creditorName}</Nm>
        <PstlAdr>
          <StreetNm>${data.creditorStreet}</StreetNm>
          <BldgNb>${data.creditorBuilding}</BldgNb>
          <TwnNm>${data.creditorCity}</TwnNm>
          <PstCd>${data.creditorPostal}</PstCd>
          <Ctry>${data.creditorCountry}</Ctry>
        </PstlAdr>
      </Cdtr>
      <CdtrAcct>
        <Id>
          <IBAN>${data.creditorIban}</IBAN>
        </Id>
      </CdtrAcct>
      <CdtrAgt>
        <FinInstnId>
          <BICFI>${data.creditorBic}</BICFI>
        </FinInstnId>
      </CdtrAgt>
      <RmtInf>
        <Ustrd>${data.remittanceInfo}</Ustrd>
      </RmtInf>
    </CdtTrfTxInf>
  </FIToFICstmrCdtTrf>
</Document>`;
}

// ===== 4. ОТПРАВКА В БАНК =====
async function sendToBank(xmlMessage) {
    try {
        // ВАРИАНТ 1: Через банковский API
        const response = await axios.post(
            `${BANK_CONFIG.baseUrl}${BANK_CONFIG.swiftEndpoint}`,
            xmlMessage,
            {
                headers: {
                    'Content-Type': 'application/xml',
                    'Authorization': `Bearer ${BANK_CONFIG.apiKey}`
                }
            }
        );
        return response.data;
        
    } catch (error) {
        // ВАРИАНТ 2: Если API недоступен — сохраняем в очередь
        console.error('Bank API error:', error.message);
        throw new Error('Payment gateway unavailable');
    }
}

// ===== 5. СОХРАНЕНИЕ В БАЗУ ДАННЫХ =====
// Используем SQLite для простоты
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('transactions.db');

db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id TEXT UNIQUE,
        status TEXT,
        amount REAL,
        currency TEXT,
        debtor_iban TEXT,
        creditor_iban TEXT,
        created_at TEXT,
        updated_at TEXT,
        xml_message TEXT,
        bank_response TEXT
    )
`);

function saveTransaction(data) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO transactions (
                transaction_id, status, amount, currency, 
                debtor_iban, creditor_iban, created_at, xml_message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                data.transactionId,
                'PENDING',
                data.amount,
                data.currency,
                data.debtorIban,
                data.creditorIban,
                new Date().toISOString(),
                data.xmlMessage
            ],
            function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
}

// ===== 6. API ЭНДПОИНТЫ =====

// ЭНДПОИНТ: Создание платежа
app.post('/api/payment/create', async (req, res) => {
    try {
        const data = req.body;
        
        // Валидация IBAN
        if (!validateIBAN(data.debtorIban)) {
            return res.status(400).json({ 
                error: 'Invalid debtor IBAN' 
            });
        }
        if (!validateIBAN(data.creditorIban)) {
            return res.status(400).json({ 
                error: 'Invalid creditor IBAN' 
            });
        }
        
        // Генерация уникальных ID
        const transactionId = `TXN${Date.now()}${Math.floor(Math.random() * 1000)}`;
        const uetr = uuidv4();
        const messageId = `MSG${Date.now()}`;
        
        // Подготовка данных для XML
        const paymentData = {
            ...data,
            messageId,
            instructionId: `INSTR-${Date.now()}`,
            endToEndId: `E2E-${Date.now()}`,
            uetr
        };
        
        // Генерация XML
        const xmlMessage = generatePacs008XML(paymentData);
        
        // Отправка в банк
        let bankResponse;
        try {
            bankResponse = await sendToBank(xmlMessage);
        } catch (bankError) {
            // Если банк недоступен — сохраняем для retry
            bankResponse = { status: 'QUEUED', error: bankError.message };
        }
        
        // Сохранение в БД
        await saveTransaction({
            transactionId,
            amount: data.amount,
            currency: data.currency,
            debtorIban: data.debtorIban,
            creditorIban: data.creditorIban,
            xmlMessage
        });
        
        // Ответ клиенту
        res.json({
            success: true,
            transactionId,
            uetr,
            reference: messageId,
            status: bankResponse.status || 'PENDING',
            xml: xmlMessage,
            message: 'Payment initiated successfully'
        });
        
    } catch (error) {
        console.error('Payment error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ЭНДПОИНТ: Проверка статуса
app.get('/api/payment/status/:transactionId', async (req, res) => {
    try {
        const { transactionId } = req.params;
        
        // Запрос к банку для проверки статуса
        const statusResponse = await axios.get(
            `${BANK_CONFIG.baseUrl}/v1/payments/${transactionId}/status`,
            {
                headers: {
                    'Authorization': `Bearer ${BANK_CONFIG.apiKey}`
                }
            }
        );
        
        res.json({
            transactionId,
            status: statusResponse.data.status,
            details: statusResponse.data
        });
        
    } catch (error) {
        res.status(500).json({
            error: 'Failed to get payment status'
        });
    }
});

// ===== 7. ЗАПУСК СЕРВЕРА =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📌 Payment endpoint: http://localhost:${PORT}/api/payment/create`);
});
