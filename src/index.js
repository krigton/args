import parser from 'minimist'
import pkginfo from 'pkginfo'
import camelcase from 'camelcase'
import path from 'path'
import { spawn } from 'child_process'
import loudRejection from 'loud-rejection'
import replace from 'replaceall'
import chalk from 'chalk'

class Args {
  constructor () {
    // Will later hold registered options and commands
    this.details = {
      options: [],
      commands: []
    }

    // Configuration defaults
    this.config = {
      help: true,
      version: true,
      usageFilter: null,
      value: null
    }

    // Make unhandled promise rejections fail loudly instead of the default silent fail
    loudRejection()
  }

  options (list) {
    if (list.constructor != Array) {
      throw new Error('Item passed to .options is not an array')
    }

    for (let item of list) {
      let preset = item.defaultValue || false,
          init = item.init || false

      this.option(item.name, item.description, preset, init)
    }

    return this
  }

  option (name, description, defaultValue, init) {
    let usage = []

    // If name is an array, pick the values
    // Otherwise just use the whole thing
    switch (name.constructor) {
      case String:
        usage[0] = name.charAt(0)
        usage[1] = name

        break
      case Array:
        usage = usage.concat(name)
        break
      default:
        throw new Error('Invalid name for option')
    }

    // Throw error if short option is too long
    if (usage.length > 0 && usage[0].length > 1) {
      throw new Error('Short version of option is longer than 1 char')
    }

    let optionDetails = {
      defaultValue,
      usage,
      description
    }

    let defaultIsWrong = false

    switch (defaultValue) {
      case false:
        defaultIsWrong = true
        break
      case null:
        defaultIsWrong = true
        break
      case undefined:
        defaultIsWrong = true
        break
    }

    // Set initializer depending on type of default value
    if (!defaultIsWrong) {
      let initFunction = typeof init === 'function'
      optionDetails.init = initFunction ? init : this.handleType(defaultValue)[1]
    }

    // Register option to global scope
    this.details.options.push(optionDetails)

    // Allow chaining of .option()
    return this
  }

  command (usage, description, init) {
    // Register command to global scope
    this.details.commands.push({
      usage,
      description,
      init: typeof init === 'function' ? init : false
    })

    // Allow chaining of .command()
    return this
  }

  handleType (value) {
    let type = value

    if (typeof value !== 'function') {
      type = value.constructor
    }

    // Depending on the type of the default value,
    // select a default initializer function
    switch (type) {
      case String:
      case toString:
        return ['[value]']
        break
      case Array:
        return ['<list>']
        break
      case Number:
      case parseInt:
        return ['<n>', parseInt]
        break
      default:
        return false
    }
  }

  readOption (option) {
    let value = false,
        contents = {}

    // If option has been used, get its value
    for (let name of option.usage) {
      let fromArgs = this.raw[name]

      if (fromArgs) {
        value = fromArgs
      }
    }

    // Process the option's value
    for (let name of option.usage) {
      let propVal = value || option.defaultValue,
          condition = true

      if (option.init) {
        // Only use the toString initializer if value is a number
        if (option.init === toString) {
          condition = propVal.constructor === Number
        }

        if (condition) {
          // Pass it through the initializer
          propVal = option.init(propVal)
        }
      }

      // Camelcase option name
      name = camelcase(name)

      // Add option to list if it has a value
      if (propVal) contents[name] = propVal
    }

    return contents
  }

  getOptions () {
    let options = {},
        args = {}

    // Copy over the arguments
    Object.assign(args, this.raw)
    delete args._

    // Set option defaults
    for (let option of this.details.options) {
      if (!option.defaultValue) continue
      Object.assign(options, this.readOption(option))
    }

    // Override defaults if used in command line
    for (let option in args) {
      let related = this.isDefined(option, 'options')

      if (related) {
        let details = this.readOption(related)
        Object.assign(options, details)
      }
    }

    return options
  }

  generateDetails (kind) {
    // Get all properties of kind from global scope
    const items = this.details[kind]
    let parts = []

    // Sort items alphabetically
    items.sort((a, b) => {
      const isCmd = kind == 'commands'

      let first = isCmd ? a.usage : a.usage[1],
          second = isCmd ? b.usage : b.usage[1]

      switch (true) {
        case (first < second): return -1
        case (first > second): return 1
        default: return 0
      }
    })

    for (let item in items) {
      let usage = items[item].usage,
          initial = items[item].defaultValue

      // If usage is an array, show its contents
      if (usage.constructor === Array) {
        let isVersion = usage.indexOf('v')
        usage = `-${usage[0]}, --${usage[1]}`

        if (!initial) {
          initial = items[item].init
        }

        usage += (initial && isVersion == -1) ? ' ' + this.handleType(initial)[0] : ''
      }

      // Overwrite usage with readable syntax
      items[item].usage = usage
    }

    // Find length of longest option or command
    // Before doing that, make a copy of the original array
    const longest = items.slice().sort((a, b) => {
      return b.usage.length - a.usage.length
    })[0].usage.length

    for (let item of items) {
      let usage = item.usage,
          difference = longest - usage.length

      // Compensate the difference to longest property with spaces
      usage += ' '.repeat(difference)

      // Add some space around it as well
      parts.push('  ' + chalk.yellow(usage) + '  ' + chalk.dim(item.description))
    }

    return parts
  }

  runCommand (details, options) {
    // If help is disabled, remove initializer
    if (details.usage === 'help' && !this.config.help) {
      details.init = false
    }

    // If command has initializer, call it
    if (details.init) {
      let sub = [].concat(this.sub)
      sub.shift()

      return details.init.bind(this)(details.usage, sub, options)
    }

    // Generate full name of binary
    const full = this.binary + '-' + details.usage

    let args = process.argv,
        i = 0

    while (i < 3) {
      args.shift()
      i++
    }

    // Run binary of sub command
    this.child = spawn(full, args, {
      stdio: 'inherit',
      detached: true
    })

    // Throw an error if something fails within that binary
    this.child.on('error', err => {
      throw err
    })
  }

  checkVersion () {
    const parent = module.parent

    // Load parent module
    pkginfo(parent)

    // And get its version propery
    const version = parent.exports.version

    if (version) {
      // If it exists, register it as a default option
      this.option('version', 'Output the version number', version)

      // And immediately output it if used in command line
      if (this.raw.v || this.raw.version) {
        console.log(version)
        process.exit()
      }
    }
  }

  isDefined (name, list) {
    // Get all items of kind
    const children = this.details[list]

    // Check if a child matches the requested name
    for (let child of children) {
      let usage = child.usage,
          type = usage.constructor

      if (type === Array && usage.indexOf(name) > -1) {
        return child
      }

      if (type === String && usage === name) {
        return child
      }
    }

    // If nothing matches, item is not defined
    return false
  }

  parse (argv, options) {
    // Override default option values
    Object.assign(this.config, options)

    if (this.config.help) {
      // Register default options and commands
      this.option('help', 'Output usage information')
      this.command('help', 'Display help', this.showHelp)
    }

    // Parse arguments using minimist
    this.raw = parser(argv.slice(1))
    this.binary = path.basename(this.raw._[0])

    // If default version is allowed, check for it
    if (this.config.version) {
      this.checkVersion()
    }

    const subCommand = this.raw._[1],
          helpTriggered = this.raw.h || this.raw.help

    let args = {},
        defined = this.isDefined(subCommand, 'commands'),
        optionList = this.getOptions()

    Object.assign(args, this.raw)
    args._.shift()

    // Export sub arguments of command
    this.sub = args._

    // If sub command is defined, run it
    if (defined) {
      this.runCommand(defined, optionList)
      return {}
    }

    // Show usage information if "help" or "h" option was used
    // And respect the option related to it
    if (this.config.help && helpTriggered) {
      this.showHelp()
    }

    // Hand back list of options
    return optionList
  }

  showHelp () {
    const binary = this.binary.replace('-', ' '),
          firstBig = word => word.charAt(0).toUpperCase() + word.substr(1)

    let parts = []

    let groups = {
      commands: true,
      options: true
    }

    for (let group in groups) {
      if (this.details[group].length > 0) {
        continue
      }

      groups[group] = false
    }

    const optionHandle = groups.options ? ' [options]' : '',
          cmdHandle = groups.commands ? ' [command]' : '',
          value = typeof this.config.value === 'string' ? ' ' + this.config.value : ''

    parts.push([
      '',
      'Usage: ' + chalk.yellow(binary) + chalk.dim(optionHandle + cmdHandle + value),
      ''
    ])

    for (let group in groups) {
      if (!groups[group]) {
        continue
      }

      parts.push([
        '',
        firstBig(group) + ':',
        '',
        ''
      ])

      parts.push(this.generateDetails(group))
      parts.push(['', ''])
    }

    let output = ''

    // And finally, merge and output them
    for (let part of parts) {
      output += part.join('\n  ')
    }

    if (!groups.commands && !groups.options) {
      output = 'No sub commands or options available'
    }

    const usageFilter = this.config.usageFilter

    // If filter is available, pass usage information through
    if (typeof usageFilter === 'function') {
      output = usageFilter(output) || output
    }

    console.log(output)
    process.exit()
  }
}

export default new Args
