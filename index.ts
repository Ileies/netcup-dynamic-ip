import {readFile, writeFile} from 'fs/promises'
import {join} from 'path'

interface Account {
    apiKey: string
    apiPassword: string
    customerNumber: string
    domains: string[]
}

type Config = Account[]

const args = process.argv.slice(2)
let configPath = join(import.meta.dir, '..', 'config.json')
for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--config' || args[i] === '-c') && args[i + 1]) {
        configPath = args[++i]
    } else if (!args[i].startsWith('-')) {
        configPath = args[i]
    }
}

let config: Config
try {
    config = JSON.parse(await readFile(configPath, 'utf-8'))
} catch (e) {
    console.error(`Failed to load config from ${configPath}:`, e)
    process.exit(1)
}

const previousIpFile = join(import.meta.dir, '..', 'ip.txt')

let currentIp: string
try {
    currentIp = (await readFile(previousIpFile, 'utf-8')).trim()
} catch {
    currentIp = ''
}

function parseDomain(domain: string): {domainname: string; hostname: string} {
    const parts = domain.split('.')
    if (parts.length <= 2) {
        return {domainname: domain, hostname: '@'}
    }
    return {
        domainname: parts.slice(-2).join('.'),
        hostname: parts.slice(0, -2).join('.')
    }
}

async function netcupAPI(endpoint: string, param: Record<string, any> = {}) {
    const rawData = await fetch('https://ccp.netcup.net/run/webservice/servers/endpoint.php?JSON', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action: endpoint, param})
    })
    const data = await rawData.json()
    console.log(data)
    return data
}

async function updateDnsRecords(domain: string, account: Account) {
    const {apiKey: apikey, apiPassword: apipassword, customerNumber: customernumber} = account
    const {domainname, hostname} = parseDomain(domain)
    console.log(`Updating ${domainname} (${hostname})...`)

    const loginData = await netcupAPI('login', {apipassword, apikey, customernumber})
    const apisessionid = loginData.responsedata?.apisessionid

    if (!apisessionid) {
        console.log('Failed to obtain session ID. Aborting update.')
        return
    }

    const dnsRecordsData = await netcupAPI('infoDnsRecords', {apikey, customernumber, apisessionid, domainname})
    const ipRecord = dnsRecordsData.responsedata.dnsrecords
        .find((record: any) => record.type === 'A' && record.hostname === hostname)

    const oldIp = ipRecord?.destination

    if (oldIp === currentIp) {
        console.log('IP is identical. Not updating.')
    } else {
        const updatedIpRecord = {...ipRecord, destination: currentIp}
        await netcupAPI('updateDnsRecords', {
            domainname,
            apisessionid,
            customernumber,
            apikey,
            dnsrecordset: {dnsrecords: [updatedIpRecord]}
        })
    }

    await netcupAPI('logout', {apisessionid, customernumber, apikey})
}

async function checkIp() {
    const newIpResponse = await fetch('https://api.ipify.org')
    const newIp = await newIpResponse.text()

    if (!currentIp || newIp !== currentIp) {
        console.log(`[${new Date().toISOString()}] New IP: ${newIp}`)
        await writeFile(previousIpFile, newIp)
        currentIp = newIp
        for (const account of config) {
            for (const domain of account.domains) {
                await updateDnsRecords(domain, account)
            }
        }
    }
}

console.log(`Started: ${new Date().toISOString()}`)

checkIp()
setInterval(checkIp, 60 * 1000)
