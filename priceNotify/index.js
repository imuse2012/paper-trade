import express from 'express'
import Iconv from 'iconv-lite'
import bodyParser from 'body-parser'
import Config from '../config'
import http from 'http'
import JPush from 'jpush-sdk'
import amqp from 'amqplib'
const jpushRegIDSql = "SELECT a.*,b.JpushRegID FROM wf_securities_remind a LEFT JOIN wf_im_jpush b ON a.MemberCode = b.MemberCode WHERE a.IsOpenLower=1 OR a.IsOpenUpper=1 OR a.IsOpenRise=1 OR a.IsOpenFall=1";
const jpush = Config.CreateJpushClient();
const sequelize = Config.CreateSequelize();
const redisClient = Config.CreateRedisClient();
import StockRef from '../getSinaData/stocksRef'
var stocksRef = new StockRef()
var notifies = new Map()

function isAllClose({ IsOpenLower, IsOpenUpper, IsOpenRise, IsOpenFall }) {
    return !(IsOpenLower || IsOpenUpper || IsOpenRise || IsOpenFall)
}
//rabitmq 通讯
async function startMQ() {
    var amqpConnection = await amqp.connect(Config.amqpConn)
    let channel = await amqpConnection.createChannel()
    let ok = await channel.assertQueue('priceNotify')
    channel.consume('priceNotify', msg => {
        let { cmd, data } = JSON.parse(msg.content.toString())
        switch (cmd) {
            case "update":
                if (notifies.has(data.RemindId)) {
                    if (isAllClose(data)) {
                        if (stocksRef.removeSymbol(name))
                            channel.sendToQueue("getSinaData", new Buffer(JSON.stringify({ type: "remove", listener: "priceNotify", symbols: [name] })))
                    } else
                        Object.assign(notifies.get(data.RemindId), data)
                } else {
                    if (!isAllClose(data)) {
                        notifies.set(data.RemindId, data)
                        let name = Config.sina_qmap[data.SmallType] + data.SecuritiesNo
                        if (stocksRef.addSymbol(name))
                            channel.sendToQueue("getSinaData", new Buffer(JSON.stringify({ type: "add", listener: "priceNotify", symbols: [name] })))
                    }
                }
                break;
            case "changeJpush":
                let { MemberCode, JpushRegID } = data
                for (let notify of notifies.values) {
                    if (notify.MemberCode == MemberCode) notify.JpushRegID = JpushRegID
                }
                break;
        }
        channel.ack(msg)
    })
    await channel.assertExchange("broadcast", "fanout")
    ok = await channel.assertQueue('sinaData')
    ok = await channel.bindQueue('sinaData', 'broadcast', 'fanout')
    channel.consume('sinaData', msg => {
        switch (msg.content.toString()) {
            case "restart": //股票引擎重启信号
                channel.sendToQueue("getSinaData", new Buffer(JSON.stringify({ type: "reset", listener: "priceNotify", symbols: stocksRef.array })))
                break;
        }
        channel.ack(msg)
    })
}
startMQ()


/**
 * 获取jpushregid和所有提醒数据
 */
async function getAllNotify() {
    notifies.clear()
    stocksRef.clear()
    let [ns] = await sequelize.query(Config.jpushRegIDSql)
    for (let n of ns) {
        n.IsOpenLower = n.IsOpenLower[0] == 1
        n.IsOpenUpper = n.IsOpenUpper[0] == 1
        n.IsOpenRise = n.IsOpenRise[0] == 1
        n.IsOpenFall = n.IsOpenFall[0] == 1
        notifies[n.RemindId] = n
        let name = Config.sina_qmap[n.SmallType] + n.SecuritiesNo
        stocksRef.addSymbol(name)
            //console.log(n)
    }
}
getAllNotify()
    // const app = express();
    // app.use(bodyParser.json())
    // app.use(bodyParser.urlencoded({ extended: true }))
    // app.use('/', (req, res) => {
    //         res.json({ notifies, stocks_name, stocks })
    //     })
    //     //添加提醒
    // app.use('/addNotify', (req, res) => {
    //     let { SmallType, SecuritiesNo, RemindId } = req.body
    //     let name = Config.sina_qmap[SmallType] + SecuritiesNo
    //     notifies[RemindId] = req.body
    //     if (!stocksRef[name]) {
    //         stocksRef[name] = 1
    //         if (!stocks_name) stocks_name = name
    //         else stocks_name += "," + name
    //     } else stocksRef[name]++
    //         res.json({ Status: 0, Explain: "" })
    //         //res.cookie('user', 'value', { signed: true })
    // })
    // app.use('/modifyNotify', (req, res) => {
    //     let { SmallType, SecuritiesNo, RemindId } = req.body
    //     let name = Config.sina_qmap[SmallType] + SecuritiesNo
    //     notifies[RemindId] = req.body
    // })
    // app.use('/updateJpushRegID', (req, res) => {
    //     let { MemberCode, JpushRegID } = req.body
    //     for (let nid in notifies) {
    //         let notify = notifies[nid]
    //         if (notify.MemberCode == MemberCode) notify.JpushRegID = JpushRegID
    //     }
    // })

function sendNotify(type, nofity, price) {
    let msg = "沃夫街股价提醒:" + nofity.SecuritiesNo
    switch (type) {
        case 0:
            msg += ` 当前价格 ${price} 已经向下击穿 ${nofity.LowerLimit}`
            break
        case 1:
            msg += ` 当前价格 ${price} 已经向下突破 ${nofity.IsOpenUpper}`
            break
        case 2:
            msg += ` 当前跌幅 ${price} 已经超过 ${nofity.FallLimit}`
            break
        case 3:
            msg += ` 当前涨幅 ${price} 已经超过 ${nofity.RiseLimit}`
            break
    }
    jpush.push().setPlatform(JPush.ALL).setAudience(JPush.registration_id(nofity.JpushRegID))
        .setNotification('股价提醒', JPush.ios(msg, 'sound', 0, false, { AlertType: Config.jpushType, SmallType: nofity.SmallType, SecuritiesNo: nofity.SecuritiesNo }), JPush.android(msg, '沃夫街股价提醒', 1, { AlertType: Config.jpushType, SmallType: nofity.SmallType, SecuritiesNo: nofity.SecuritiesNo }))
        .send((err, res) => {
            if (err) {
                if (err instanceof JPush.APIConnectionError) {
                    console.log(err.message)
                } else if (err instanceof JPush.APIRequestError) {
                    console.log(err.message)
                }
            } else {
                console.log('Sendno: ' + res.sendno)
                console.log('Msg_id: ' + res.msg_id)
            }
        })
}
setInterval(() => {
    //调用新浪接口
    for (let nid in notifies) {
        let notify = notifies[nid]
        let name = Config.sina_qmap[notify.SmallType] + notify.SecuritiesNo
        let sp = await redisClient.getAsync("lastPrice:" + name)
        sp = JSON.parse("[" + sp + "]")
        let price = sp[3]
        let chg = (sp[3] - sp[4]) * 100 / sp[4] //涨跌幅
        if (notify.IsOpenLower) {
            if (notify.isLowSent) {
                if (price > notify.LowerLimit) {
                    //恢复状态
                    notify.isLowSent = false
                }
            } else {
                if (price < notify.LowerLimit) {
                    //向下击穿
                    sendNotify(0, notify, price)
                    notify.isLowSent = true
                }
            }
        }
        if (notify.IsOpenUpper) {
            if (notify.isUpperSent) {
                if (price < notify.UpperLimit) {
                    //恢复状态
                    notify.isUpperSent = false
                }
            } else {
                if (price > notify.UpperLimit) {
                    //向上突破
                    sendNotify(1, notify, price)
                    notify.isUpperSent = true
                }
            }
        }
        if (chg < 0) {
            if (notify.IsOpenFall) {
                if (notify.isFallSent) {
                    if (chg > notify.FallLimit) {
                        //恢复状态
                        notify.isFallSent = false
                    }
                } else {
                    if (chg < notify.FallLimit) {
                        //向下击穿
                        sendNotify(2, notify, chg)
                        notify.isFallSent = true
                    }
                }
            }
        } else {
            if (notify.IsOpenRise) {
                if (notify.isRiseSent) {
                    if (chg < notify.RiseLimit) {
                        //恢复状态
                        notify.isRiseSent = false
                    }
                } else {
                    if (chg > notify.RiseLimit) {
                        //向上突破
                        sendNotify(3, notify, chg)
                        notify.isRiseSent = true
                    }
                }
            }
        }
    }
}, 5000);
// let server = app.listen(process.env.PORT, function() {
//     let host = server.address().address;
//     let port = server.address().port;

//     console.log('server listening at %s %d', host, port);
// });