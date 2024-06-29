import {readFile, readdir, writeFile} from 'fs/promises'
import {basename, join} from 'path'

// Directory containing server configs
const configDir = '/etc/secrets/netcup'
// File to store the previous public IP
const previousIpFile = './ip.txt'

let currentIp: string

try {
    currentIp = (await readFile(previousIpFile, 'utf-8')).trim()
} catch {
    currentIp = ''
}

// Function to make requests to the netcup API
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

// Function to update DNS records
async function updateDnsRecords(configFile: string) {
    const domainname = basename(configFile);
    console.log(`Updating ${domainname}...`)

    const configContent = await readFile(configFile, 'utf-8')
    const config = configContent
        .split('\n')
        .reduce((acc, line) => {
            const [key, val] = line.split('=')
            if (key && val) {
                acc[key.trim()] = val.trim().replace('\r', '')
            }
            return acc
        }, {} as Record<string, string>)
    const apipassword = config['NETCUP_API_PASSWORD']
    const customernumber = config['NETCUP_CUSTOMER_NUMBER']
    const apikey = config['NETCUP_API_KEY']

    const loginData = await netcupAPI('login', {apipassword, apikey, customernumber})
    const apisessionid = loginData.responsedata?.apisessionid

    if (!apisessionid) {
        console.log('Failed to obtain session ID. Aborting update.')
        return
    }

    const dnsRecordsData = await netcupAPI('infoDnsRecords', {apikey, customernumber, apisessionid, domainname})
    const ipRecord = dnsRecordsData.responsedata.dnsrecords
        .find((record: any) => record.type === 'A' && record.hostname === '@')

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

// Function to check if the IP has changed
async function checkIp() {
    const newIpResponse = await fetch('https://api.ipify.org')
    const newIp = await newIpResponse.text()

    if (!currentIp || newIp !== currentIp) {
        console.log(`[${new Date().toISOString()}] New IP: ${newIp}`)
        await writeFile(previousIpFile, newIp)
        currentIp = newIp
        const configFiles = (await readdir(configDir)).map(file => join(configDir, file))
        for (const configFile of configFiles) {
            await updateDnsRecords(configFile)
        }
    }
}

// Log current time for debugging
console.log(`Started: ${new Date().toISOString()}`)

// Check for IP change every minute
checkIp()
setInterval(checkIp, 60 * 1000)
