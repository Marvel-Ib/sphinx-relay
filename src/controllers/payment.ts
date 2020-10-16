import {models} from '../models'
import { sendNotification } from '../hub'
import * as socket from '../utils/socket'
import * as jsonUtils from '../utils/json'
import * as helpers from '../helpers'
import { failure, success } from '../utils/res'
import {tokenFromTerms} from '../utils/ldat'
import * as network from '../network'
import * as short from 'short-uuid'
import constants from '../constants'
import { Op } from 'sequelize' 

export const sendPayment = async (req, res) => {
  const {
    amount,
    chat_id,
    contact_id,
    destination_key,
    media_type,
    muid,
    text,
    remote_text,
    dimensions,
    remote_text_map,
    contact_ids,
    reply_uuid,
  } = req.body

  console.log('[send payment]', req.body)

  if (destination_key && !contact_id && !chat_id) {
    anonymousKeysend(res, destination_key, amount||'', text||'')
    return
  }

  const owner = await models.Contact.findOne({ where: { isOwner: true }})

  const chat = await helpers.findOrCreateChat({
    chat_id,
    owner_id: owner.id,
    recipient_id: contact_id
  })

  var date = new Date();
  date.setMilliseconds(0)

  const msg: {[k:string]:any} = {
    chatId: chat.id,
    uuid: short.generate(),
    sender: owner.id,
    type: constants.message_types.direct_payment,
    amount: amount,
    amountMsat: parseFloat(amount) * 1000,
    date: date,
    createdAt: date,
    updatedAt: date
  }
  if(text) msg.messageContent = text
  if(remote_text) msg.remoteMessageContent = remote_text
  if(reply_uuid) msg.replyUuid=reply_uuid

  if(muid){
    const myMediaToken = await tokenFromTerms({
      meta:{dim:dimensions}, host:'',
      muid, ttl:null, // default one year
      pubkey: owner.publicKey
    })
    msg.mediaToken = myMediaToken
    msg.mediaType = media_type || ''
  }

  const message = await models.Message.create(msg)

  const msgToSend: {[k:string]:any} = {
    id:message.id,
    uuid:message.uuid,
    amount,
  }
  if(muid) {
    msgToSend.mediaType = media_type||'image/jpeg'
    msgToSend.mediaTerms = {muid,meta:{dim:dimensions}}
  }
  if(remote_text) msgToSend.content = remote_text
  if(reply_uuid) msgToSend.replyUuid=reply_uuid

  // if contact_ids, replace that in "chat" below
  // if remote text map, put that in
  let theChat = chat
  if(contact_ids){
    theChat = {...chat.dataValues, contactIds:contact_ids}
    if(remote_text_map) msgToSend.content = remote_text_map
  }
  network.sendMessage({
    chat: theChat,
    sender: owner,
    type: constants.message_types.direct_payment,
    message: msgToSend,
    amount: amount,
    success: async (data) => {
      // console.log('payment sent', { data })
      success(res, jsonUtils.messageToJson(message, chat))
    },
    failure: async (error) => {
      await message.update({status: constants.statuses.failed})
      res.status(200);
      res.json({ 
        success: false, 
        response: jsonUtils.messageToJson(message, chat)
      });
      res.end();
    }
  })
};

async function anonymousKeysend(res, destination_key:string, amount:number, text:string){
  const owner = await models.Contact.findOne({ where: { isOwner: true }})

  const msg:{[k:string]:any} = {
    type:constants.message_types.keysend,
  }
  if(text) msg.message = {content:text}

  return helpers.performKeysendMessage({
    sender:owner,
    destination_key,
    amount,
    msg,
    success: () => {
      console.log('payment sent!')
      var date = new Date();
      date.setMilliseconds(0)
      models.Message.create({
        chatId: 0,
        type: constants.message_types.keysend,
        sender: 1,
        amount,
        amountMsat: amount*1000,
        paymentHash: '',
        date,
        messageContent: text||'',
        status: constants.statuses.confirmed,
        createdAt: date,
        updatedAt: date
      })
      success(res, {destination_key, amount})
    },
    failure: (error) => {
      res.status(200);
      res.json({ success: false, error });
      res.end();
    }
  })
}

export const receivePayment = async (payload) => {
  console.log('received payment', { payload })

  var date = new Date();
  date.setMilliseconds(0)

  const {owner, sender, chat, amount, content, mediaType, mediaToken, chat_type, sender_alias, msg_uuid, reply_uuid} = await helpers.parseReceiveParams(payload)
  if(!owner || !sender || !chat) {
    return console.log('=> no group chat!')
  }

  const msg: {[k:string]:any} = {
    chatId: chat.id,
    uuid: msg_uuid,
    type: constants.message_types.direct_payment,
    sender: sender.id,
    amount: amount,
    amountMsat: parseFloat(amount) * 1000,
    date: date,
    createdAt: date,
    updatedAt: date
  }
  if(content) msg.messageContent = content
  if(mediaType) msg.mediaType = mediaType
  if(mediaToken) msg.mediaToken = mediaToken
  if(chat_type===constants.chat_types.tribe) {
		msg.senderAlias = sender_alias
  }
  if(reply_uuid) msg.replyUuid = reply_uuid
  
  const message = await models.Message.create(msg)

  // console.log('saved message', message.dataValues)

  socket.sendJson({
    type: 'direct_payment',
    response: jsonUtils.messageToJson(message, chat, sender)
  })

  sendNotification(chat, msg.senderAlias||sender.alias, 'message')
}

export const listPayments = async (req, res) => {
  const limit = (req.query.limit && parseInt(req.query.limit)) || 100
  const offset = (req.query.offset && parseInt(req.query.offset)) || 0
  
  const MIN_VAL=constants.min_sat_amount
  try {
    const msgs = await models.Message.findAll({
      where:{
        type: {[Op.or]: [
          constants.message_types.payment,
          constants.message_types.direct_payment
        ]},
        amount: {
          [Op.gt]: MIN_VAL // greater than
        }
      },
      order: [['createdAt', 'desc']],
      limit,
      offset
    })
    const ret = msgs||[]
    success(res, ret.map(message=> jsonUtils.messageToJson(message, null)))
  } catch(e) {
    failure(res, 'cant find payments')
  }
};

