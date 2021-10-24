const mongoose = require('mongoose')
const Bank = require("./models/Bank")
const Account = require("./models/Account")
const Session = require("./models/Session")
const Transaction = require("./models/Transaction")
const fetch = require("node-fetch")
const jose = require('node-jose')
const fs = require('fs')
//const {sendRequest} = require("./middlewares");

exports.verifyToken = async (req, res, next) => {

    // Check Authorization header existence
    let authorizationHeader = req.header('Authorization')
    if (!authorizationHeader) {
        return res.status(401).send({error: 'Missing Authorization header'})
    }

    // Split Authorization header by space
    authorizationHeader = authorizationHeader.split(' ')

    // Check that Authorization header includes a space
    if (!authorizationHeader[1]) {
        return res.status(400).send({error: 'Invalid Authorization header format'})
    }

    // Validate that the provided token conforms to MongoDB id format
    if (!mongoose.Types.ObjectId.isValid(authorizationHeader[1])) {
        return res.status(401).send({error: 'Invalid token'})
    }

    // Find a session with given token
    const session = await Session.findOne({_id: authorizationHeader[1]})

    // Check that the session existed
    if (!session) return res.status(401).send({error: 'Invalid token'})

    // Store the user's id in the req objects
    req.userId = session.userId
    req.sessionId = session.id

    return next(); // Pass the execution to the next middleware function

}

exports.refreshListOfBanksFromCentralBank = async function refreshListOfBanksFromCentralBank() {
    console.log('Refreshing list of banks')

    try {

        //Attempt to get a list of banks in JSON format form central bank
        let banks = await fetch(process.env.CENTRAL_BANK_URL, {
            headers: {'Api-Key': process.env.CENTRAL_BANK_APIKEY}
        }).then(responseText => responseText.json())

        // delete all data from banks collection
        await Bank.deleteMany()

        // Initialize bulk operation object
        const bulk = Bank.collection.initializeUnorderedBulkOp()

        banks.forEach(bank => {
            bulk.insert(bank)
        })

        // Bulk insert (in parallel) all prepared data to DB
        await bulk.execute()

        console.log('Done')
        return true

    } catch (e) {

        //Handle error
        console.log('Error:' + e.message)
        return {error: e.message}
    }

}


function isExpired(transaction) {
    // check of the transaction has expired
    const expireDate = new Date(transaction.createdAt.setDate(transaction.createdAt.getDate() + 3))
    return new Date > expireDate

}

async function setStatus(transaction, status, statusDetail) {

    console.log('Setting transaction ' + transaction._id + ' as ' + status + (statusDetail ? ' (' + statusDetail + ')' : ''))
    // Set transaction status to in progress
    transaction.status = status
    transaction.statusDetail = statusDetail
    await transaction.save()
}

async function createSignedTransaction(input) {

    let privateKey
    try {
        privateKey = fs.readFileSync('private.key', 'utf8')
        const keystore = jose.JWK.createKeyStore();
        const key = await keystore.add(privateKey, 'pem')
        return await jose.JWS.createSign({format: 'compact'}, key).update(JSON.stringify(input), "utf8").final()
    } catch (err) {
        console.error('Error reading private key' + err)
        throw Error('Error reading private key' + err)
    }
}

async function sendRequestToBank(destinationBank, transactionAsJwt) {

    return await exports.sendPostRequest(destinationBank.transactionUrl, {jwt: transactionAsJwt})

}

exports.sendPostRequest = async (url, data) => {
    return await exports.sendRequest('post', url, data)
}

exports.sendGetRequest = async (url) => {
    return await exports.sendRequest('get', url, null)
}

exports.sendRequest = async (method, url, data) => {
    let responseText = '';

    let options = {
        method,
        headers: {'Content-Type': 'application/json'}
    }

    if (data) {
        options.body = JSON.stringify(data)
    }

    try {
        let response = await fetch(url, options);

        // Parse response body text
        responseText = await response.text()

        return JSON.parse(responseText);

    } catch (e) {
        throw new Error('sendRequest('+url+'): ' + e.message +  (typeof responseText === 'undefined' ? '': '|' + responseText))
    }
}

async function refund(transaction) {
    try {
        const accountFrom = await Account.findOne({number: transaction.accountFrom})
        console.log('Refunding transaction ' + transaction._id + ' by ' + transaction.amount)
        accountFrom.balance += transaction.amount
    } catch (e) {
        console.log('Error refunding account: ')
        console.log('Reason: ' + e.message)
    }
}

exports.processTransactions = async function () {

    // Get pending transactions
    const pendingTransactions = await Transaction.find({status: 'Pending'})

    // Loop through all pending
    pendingTransactions.forEach(async transaction => {

        console.log('Processing transaction ' + transaction._id)

        // Assert that the transaction has not expired
        if (isExpired(transaction)) {
            await refund(transaction)
            return await setStatus(transaction, 'Failed', 'Expired')
        }

        // Set transaction status to in progress ________________________________________________________________
        await setStatus(transaction, 'In progress');

        // Get the bank from accountTo
        let bankPrefix = transaction.accountTo.substring(0, 3)
        let destinationBank = await Bank.findOne({bankPrefix})

        // If we don't have the bank in local database
        if (!destinationBank) {
            let result = exports.refreshListOfBanksFromCentralBank()
            if (typeof result.error !== 'undefined') {
                return await setStatus(transaction, 'Pending', 'Central bank refresh failed: ' + result.error)
            }

            destinationBank = Bank.setTraceFunction(traceFunction).findOne({bankPrefix});

            if (!destinationBank) {
                console.log('Failed', 'Bank' + bankPrefix + ' does not exist')
                await refund(transaction);
                return await setStatus(transaction, 'Failed', 'Bank' + bankPrefix + ' does not exist')

            }
        }

        try {
            const response = await sendRequestToBank(destinationBank, await createSignedTransaction({
                accountFrom: transaction.accountFrom,
                accountTo: transaction.accountTo,
                amount: transaction.amount,
                currency: transaction.currency,
                explanation: transaction.explanation,
                senderName: transaction.senderName
            }));

            /*if (typeof response.error !== 'undefined') {
                return await setStatus(transaction, 'Failed', response.error)

            }*/

            transaction.receiverName = response.receiverName
            console.log('Completed transaction ' + transaction._id)
            return await setStatus(transaction, 'Completed', '')


        } catch (e) {
            console.log(e)
            console.log('Error sending request to destination bank:')
            console.log('- Transaction id is: ' + transaction._id)
            console.log('- Error is: ' + e.message)

            return await setStatus(transaction, 'Pending', e.message)

        }

        if (!bankTo) {console.log('loop: WARN: failed to get bankTo')
            //set transaction status failed
            transaction.status='failed'
            transaction.statusDetail = 'There is no bank with prefix ' + bankPrefix
            transaction.save()
            return
        }


        // Actually send the request
        const nock = require('nock')
        let nockScope

        if (process.env.Test_Mode === 'true') {
            const nockUrl = new URL(bankTo.transactionUrl)

            console.log('Nocking '+JSON.stringify(nockUrl))

            nockScope = nock(`${nockUrl.protocol}//${nockUrl.host}`)
                .persist()
                .post(nockUrl.pathname)
                .reply(200, {receiverName: "Juss"})
        }


    }, Error)


    //Recursively call itself again
    setTimeout(exports.processTransactions, 1000)
}