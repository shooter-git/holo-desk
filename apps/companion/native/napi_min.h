/*
 * The few Node-API calls HO[LO] Engine's native piece makes, declared as Node-API defines them
 * (js_native_api.h), and found at load time in the Node that loads it. So it builds for any OS from
 * any OS (no Node headers, no import library), and loads into node, node.exe or the single
 * executable alike.
 */
#ifndef HOLO_NAPI_MIN_H
#define HOLO_NAPI_MIN_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef int napi_status; /* napi_ok is 0 */
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

typedef enum {
  napi_int8_array,
  napi_uint8_array,
  napi_uint8_clamped_array,
  napi_int16_array,
  napi_uint16_array,
  napi_int32_array,
  napi_uint32_array,
  napi_float32_array,
  napi_float64_array,
  napi_bigint64_array,
  napi_biguint64_array
} napi_typedarray_type;

typedef enum {
  napi_undefined,
  napi_null,
  napi_boolean,
  napi_number,
  napi_string,
  napi_symbol,
  napi_object,
  napi_function,
  napi_external,
  napi_bigint
} napi_valuetype;

/* X(return type, name, parameters) for each call */
#define HOLO_NAPI_CALLS(X)                                                                                      \
  X(napi_status, napi_create_function,                                                                         \
    (napi_env, const char *, size_t, napi_callback, void *, napi_value *))                                     \
  X(napi_status, napi_set_named_property, (napi_env, napi_value, const char *, napi_value))                    \
  X(napi_status, napi_get_named_property, (napi_env, napi_value, const char *, napi_value *))                  \
  X(napi_status, napi_get_cb_info, (napi_env, napi_callback_info, size_t *, napi_value *, napi_value *, void **)) \
  X(napi_status, napi_create_object, (napi_env, napi_value *))                                                 \
  X(napi_status, napi_create_array_with_length, (napi_env, size_t, napi_value *))                              \
  X(napi_status, napi_set_element, (napi_env, napi_value, uint32_t, napi_value))                               \
  X(napi_status, napi_create_double, (napi_env, double, napi_value *))                                         \
  X(napi_status, napi_create_string_utf8, (napi_env, const char *, size_t, napi_value *))                      \
  X(napi_status, napi_get_boolean, (napi_env, bool, napi_value *))                                             \
  X(napi_status, napi_get_undefined, (napi_env, napi_value *))                                                 \
  X(napi_status, napi_typeof, (napi_env, napi_value, napi_valuetype *))                                        \
  X(napi_status, napi_get_value_double, (napi_env, napi_value, double *))                                      \
  X(napi_status, napi_get_value_bool, (napi_env, napi_value, bool *))                                          \
  X(napi_status, napi_get_typedarray_info,                                                                     \
    (napi_env, napi_value, napi_typedarray_type *, size_t *, void **, napi_value *, size_t *))                 \
  X(napi_status, napi_throw_error, (napi_env, const char *, const char *))                                      \
  X(napi_status, napi_add_env_cleanup_hook, (napi_env, void (*)(void *), void *))

#endif
