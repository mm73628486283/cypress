import _ from 'lodash'
import structuredClonePonyfill from 'core-js-pure/actual/structured-clone'

export const UNSERIALIZABLE = '__cypress_unserializable_value'

// If a native structuredClone exists, use that to determine if a value can be serialized or not. Otherwise, use the ponyfill.
// we need this because some implementations of SCA treat certain values as unserializable (ex: Error is serializable in ponyfill but NOT in firefox implementations)
// @ts-ignore
const structuredCloneRef = window?.structuredClone || structuredClonePonyfill

const isSerializableInCurrentBrowser = (value: any) => {
  try {
    structuredCloneRef(value)

    // @ts-ignore
    if (Cypress.isBrowser('firefox') && _.isError(value) && structuredCloneRef !== window?.structuredClone) {
      /**
       * NOTE: structuredClone() was introduced in Firefox 94. Supported versions below 94 need to use the ponyfill
       * to determine whether or not a value can be serialized through postMessage. Since the ponyfill deems Errors
       * as clone-able, but postMessage does not in Firefox, we must make sure we do NOT attempt to send native errors through firefox
       */
      return false
    }

    return true
  } catch (e) {
    return false
  }
}

/**
 * Walks the prototype chain and finds any serializable properties that exist on the object or its prototypes.
 * If the property can be serialized, the property is added to the literal.
 * This means read-only properties are now read/write on the literal.
 *
 * Please see https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm#things_that_dont_work_with_structured_clone for more details.
 * @param obj Object that is being converted
 * @returns a new object void of prototype chain (object literal) with all serializable properties
 */
const convertObjectToSerializableLiteral = (obj): typeof obj => {
  const allProps: string[] = []
  let currentObjectRef = obj

  do {
    const props = Object.getOwnPropertyNames(currentObjectRef)

    props.forEach((prop: string) => {
      if (!allProps.includes(prop) && isSerializableInCurrentBrowser(currentObjectRef[prop])) {
        allProps.push(prop)
      }
    })

    currentObjectRef = Object.getPrototypeOf(currentObjectRef)
  } while (currentObjectRef)

  const objectAsLiteral = {}

  allProps.forEach((key) => {
    objectAsLiteral[key] = obj[key]
  })

  return objectAsLiteral
}

/**
 * Sanitizes any unserializable values from a object to prep for postMessage serialization
 * @param objectToSanitize Object that might have unserializable properties
 * @returns a copy of this object with all unserializable keys omitted from the object.
 *
 * NOTE: If an object nested inside objectToSanitize contains an unserializable property, the whole object is deemed as unserializable
 */
export const omitUnserializablePropertiesFromObj = <T>(objectToSanitize: { [key: string]: any }): T => {
  return _.pickBy(objectToSanitize, isSerializableInCurrentBrowser) as T
}

/**
 * Sanitizes any unserializable values to prep for postMessage serialization. All Objects, including Errors, are mapped to an Object literal with
 * whatever serialization properties they have, including their prototype hierarchy.
 * This keeps behavior consistent between browsers without having to worry about the inner workings of structuredClone(). For example:
 *
 * chromium
 * new Error('myError') -> Object literal with message key having value 'myError'. Also, other custom properties on the object are omitted and only name, message, and stack are preserved
 *
 * For instance:
 * var a = new Error('myError')
 * a.foo = 'bar'
 * var b = structuredClone(a)
 * b.foo // is undefined
 *
 * firefox
 * structuredClone(new Error('myError')) -> throws error as native error cannot be serialized
 *
 * This method takes a similar the 'chromium' approach to structuredClone, except that hte prototype chain is walked and ANY serializable value, including getters, are serialized.
 * Please see https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm#things_that_dont_work_with_structured_clone.
 * @param valueToSanitize subject of sanitization that might be unserializable or have unserializable properties
 * @returns a serializable form of the Error/Object. If the value passed in cannot be serialized, an error is thrown
 * @throws 'unserializable'
 */
export const preprocessErrorsForSerialization = <T>(valueToSanitize: { [key: string]: any }): T | undefined => {
// Even if native errors can be serialized through postMessage, many properties are omitted on structuredClone(), including prototypical hierarchy
// because of this, we preprocess native errors to objects and postprocess them once they come back to the primary domain

  if (_.isArray(valueToSanitize)) {
    return _.filter(valueToSanitize, preprocessErrorsForSerialization) as unknown as T
  }

  if (_.isObject(valueToSanitize)) {
    try {
      const sanitizedValue = convertObjectToSerializableLiteral(valueToSanitize) as T

      return sanitizedValue
    } catch (err) {
      // if its not serializable, tell the primary to inform the user that the value thrown could not be serialized
      throw UNSERIALIZABLE
    }
  }

  if (!isSerializableInCurrentBrowser(valueToSanitize)) {
    throw UNSERIALIZABLE
  }

  return valueToSanitize
}
