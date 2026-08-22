#define __STDC_WANT_LIB_EXT1__ 1

#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <node_api.h>
#include <string.h>

#include <array>
#include <string>

#include "partition-description.h"

namespace {

constexpr char kTeamIdentifier[] = "FA494ACVTF";
constexpr char kReleaseService[] = "icu.enduragent.desktop";
constexpr char kDevelopmentService[] = "icu.enduragent.desktop.dev";
constexpr char kAccount[] = "credential-encryption-key-v1";
constexpr size_t kKeyBytes = 32;

void EraseKey(std::array<unsigned char, kKeyBytes> &material) {
  memset_s(material.data(), material.size(), 0, material.size());
}

CFStringRef String(const char *value) {
  return CFStringCreateWithCString(kCFAllocatorDefault, value,
                                   kCFStringEncodingUTF8);
}

napi_value Text(napi_env env, const char *value) {
  napi_value result;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result);
  return result;
}

void Set(napi_env env, napi_value object, const char *key, napi_value value) {
  napi_set_named_property(env, object, key, value);
}

napi_value Failure(napi_env env, const char *code) {
  napi_value result;
  napi_create_object(env, &result);
  napi_value ok;
  napi_get_boolean(env, false, &ok);
  Set(env, result, "ok", ok);
  Set(env, result, "code", Text(env, code));
  return result;
}

napi_value Success(napi_env env) {
  napi_value result;
  napi_create_object(env, &result);
  napi_value ok;
  napi_get_boolean(env, true, &ok);
  Set(env, result, "ok", ok);
  return result;
}

const char *StatusCode(OSStatus status) {
  switch (status) {
  case errSecItemNotFound:
    return "item-not-found";
  case errSecDuplicateItem:
    return "duplicate-item";
  case errSecInteractionNotAllowed:
  case errSecInteractionRequired:
  case errSecNotAvailable:
    return "keychain-locked";
  case errSecAuthFailed:
    return "uninspectable-item";
  default:
    return "unknown";
  }
}

bool TrustedHost() {
  SecCodeRef self = nullptr;
  if (SecCodeCopySelf(kSecCSDefaultFlags, &self) != errSecSuccess ||
      self == nullptr)
    return false;
  SecRequirementRef requirement = nullptr;
  CFStringRef requirementText = String(
      "identifier \"icu.enduragent.desktop\" and anchor apple generic and "
      "certificate 1[field.1.2.840.113635.100.6.2.6] exists and "
      "certificate leaf[field.1.2.840.113635.100.6.1.13] exists and "
      "certificate leaf[subject.OU] = \"FA494ACVTF\"");
  const OSStatus requirementStatus = SecRequirementCreateWithString(
      requirementText, kSecCSDefaultFlags, &requirement);
  CFRelease(requirementText);
  const bool trusted =
      requirementStatus == errSecSuccess && requirement != nullptr &&
      SecCodeCheckValidity(self, kSecCSStrictValidate, requirement) ==
          errSecSuccess;
  if (requirement != nullptr)
    CFRelease(requirement);
  CFRelease(self);
  return trusted;
}

bool InteractionDisabled() {
  return SecKeychainSetUserInteractionAllowed(false) == errSecSuccess;
}

bool AllowedService(const std::string &service) {
  return service == kReleaseService || service == kDevelopmentService;
}

bool ReadService(napi_env env, napi_callback_info info, std::string &service) {
  size_t count = 1;
  napi_value argument;
  if (napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr) !=
          napi_ok ||
      count != 1) {
    return false;
  }
  napi_valuetype type;
  if (napi_typeof(env, argument, &type) != napi_ok || type != napi_string)
    return false;
  size_t bytes = 0;
  if (napi_get_value_string_utf8(env, argument, nullptr, 0, &bytes) != napi_ok)
    return false;
  std::string candidate(bytes + 1, '\0');
  size_t written = 0;
  if (napi_get_value_string_utf8(env, argument, candidate.data(),
                                 candidate.size(), &written) != napi_ok ||
      written != bytes) {
    return false;
  }
  candidate.resize(bytes);
  service = std::move(candidate);
  return AllowedService(service);
}

CFMutableDictionaryRef Query(const std::string &service) {
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  CFStringRef serviceValue = String(service.c_str());
  CFStringRef accountValue = String(kAccount);
  CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(query, kSecAttrService, serviceValue);
  CFDictionarySetValue(query, kSecAttrAccount, accountValue);
  CFRelease(serviceValue);
  CFRelease(accountValue);
  return query;
}

enum class PartitionInspection { kPresent, kAbsent, kUninspectable };

PartitionInspection InspectAccess(SecAccessRef access);

SecAccessRef MakeAccess() {
  SecAccessRef access = nullptr;
  CFStringRef label = String("Enduragent credential encryption key");
  if (SecAccessCreate(label, nullptr, &access) != errSecSuccess ||
      access == nullptr) {
    CFRelease(label);
    return nullptr;
  }
  CFRelease(label);
  CFArrayRef aclList = nullptr;
  if (SecAccessCopyACLList(access, &aclList) != errSecSuccess ||
      aclList == nullptr) {
    CFRelease(access);
    return nullptr;
  }
  const CFIndex count = CFArrayGetCount(aclList);
  CFIndex ownerCount = 0;
  for (CFIndex index = 0; index < count; index += 1) {
    SecACLRef acl = static_cast<SecACLRef>(
        const_cast<void *>(CFArrayGetValueAtIndex(aclList, index)));
    CFArrayRef authorizations = SecACLCopyAuthorizations(acl);
    if (authorizations == nullptr) {
      CFRelease(aclList);
      CFRelease(access);
      return nullptr;
    }
    const KeychainAclRole role = ClassifyKeychainAcl(authorizations);
    if (role == KeychainAclRole::kPartition ||
        role == KeychainAclRole::kUnsafe) {
      CFRelease(authorizations);
      CFRelease(aclList);
      CFRelease(access);
      return nullptr;
    }
    CFArrayRef applications = nullptr;
    CFStringRef description = nullptr;
    SecKeychainPromptSelector prompt{};
    if (SecACLCopyContents(acl, &applications, &description, &prompt) !=
        errSecSuccess) {
      if (applications != nullptr)
        CFRelease(applications);
      if (description != nullptr)
        CFRelease(description);
      CFRelease(authorizations);
      CFRelease(aclList);
      CFRelease(access);
      return nullptr;
    }
    bool acceptable = true;
    if (role == KeychainAclRole::kOwner) {
      ownerCount += 1;
      acceptable = IsExpectedOwnerAcl(authorizations, applications);
    } else {
      acceptable = SecACLSetContents(
                       acl, nullptr,
                       description == nullptr ? CFSTR("") : description,
                       prompt) == errSecSuccess;
    }
    if (applications != nullptr)
      CFRelease(applications);
    if (description != nullptr)
      CFRelease(description);
    CFRelease(authorizations);
    if (!acceptable) {
      CFRelease(aclList);
      CFRelease(access);
      return nullptr;
    }
  }
  CFRelease(aclList);
  if (ownerCount != 1) {
    CFRelease(access);
    return nullptr;
  }
  CFStringRef partition =
      String("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
             "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" "
             "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">"
             "<plist version=\"1.0\"><dict><key>Partitions</key><array>"
             "<string>teamid:FA494ACVTF</string></array></dict></plist>");
  SecACLRef partitionAcl = nullptr;
  const OSStatus createStatus = SecACLCreateWithSimpleContents(
      access, nullptr, partition, SecKeychainPromptSelector{}, &partitionAcl);
  CFRelease(partition);
  if (createStatus != errSecSuccess || partitionAcl == nullptr) {
    CFRelease(access);
    return nullptr;
  }
  const void *authorization = kSecACLAuthorizationPartitionID;
  CFArrayRef authorizations = CFArrayCreate(kCFAllocatorDefault, &authorization,
                                            1, &kCFTypeArrayCallBacks);
  const OSStatus updateStatus =
      SecACLUpdateAuthorizations(partitionAcl, authorizations);
  CFRelease(authorizations);
  CFRelease(partitionAcl);
  if (updateStatus != errSecSuccess) {
    CFRelease(access);
    return nullptr;
  }
  if (InspectAccess(access) != PartitionInspection::kPresent) {
    CFRelease(access);
    return nullptr;
  }
  return access;
}

PartitionInspection InspectAccess(SecAccessRef access) {
  CFArrayRef aclList = nullptr;
  if (SecAccessCopyACLList(access, &aclList) != errSecSuccess ||
      aclList == nullptr) {
    return PartitionInspection::kUninspectable;
  }
  PartitionInspection result = PartitionInspection::kAbsent;
  KeychainAccessAclInspection inspection{0, 0, true};
  const CFIndex count = CFArrayGetCount(aclList);
  for (CFIndex index = 0; index < count; index += 1) {
    SecACLRef acl = static_cast<SecACLRef>(
        const_cast<void *>(CFArrayGetValueAtIndex(aclList, index)));
    CFArrayRef authorizations = SecACLCopyAuthorizations(acl);
    if (authorizations == nullptr) {
      result = PartitionInspection::kUninspectable;
      break;
    }
    const KeychainAclRole role = ClassifyKeychainAcl(authorizations);
    if (role == KeychainAclRole::kUnrelated) {
      CFRelease(authorizations);
      continue;
    }
    if (role == KeychainAclRole::kUnsafe) {
      IncludeKeychainAcl(inspection, role, authorizations, nullptr, nullptr,
                         SecKeychainPromptSelector{});
      CFRelease(authorizations);
      continue;
    }
    CFArrayRef applications = nullptr;
    CFStringRef description = nullptr;
    SecKeychainPromptSelector prompt{};
    if (SecACLCopyContents(acl, &applications, &description, &prompt) !=
        errSecSuccess) {
      if (applications != nullptr)
        CFRelease(applications);
      if (description != nullptr)
        CFRelease(description);
      CFRelease(authorizations);
      result = PartitionInspection::kUninspectable;
      break;
    }
    IncludeKeychainAcl(inspection, role, authorizations, applications,
                       description, prompt);
    CFRelease(authorizations);
    if (applications != nullptr)
      CFRelease(applications);
    if (description != nullptr)
      CFRelease(description);
  }
  if (result != PartitionInspection::kUninspectable &&
      IsExpectedKeychainAccess(inspection))
    result = PartitionInspection::kPresent;
  CFRelease(aclList);
  return result;
}

PartitionInspection InspectPartition(SecKeychainItemRef item) {
  SecAccessRef access = nullptr;
  if (SecKeychainItemCopyAccess(item, &access) != errSecSuccess ||
      access == nullptr) {
    return PartitionInspection::kUninspectable;
  }
  const PartitionInspection result = InspectAccess(access);
  CFRelease(access);
  return result;
}

bool ReadyForKeychain(napi_env env, napi_value &refusal) {
  if (!InteractionDisabled()) {
    refusal = Failure(env, "keychain-locked");
    return false;
  }
  static const bool trusted = TrustedHost();
  if (!trusted) {
    refusal = Failure(env, "not-team-signed");
    return false;
  }
  return true;
}

napi_value Probe(napi_env env, napi_callback_info) {
  napi_value refusal;
  if (!ReadyForKeychain(env, refusal))
    return refusal;
  napi_value result = Success(env);
  Set(env, result, "teamIdentifier", Text(env, kTeamIdentifier));
  return result;
}

napi_value ReadKey(napi_env env, napi_callback_info info) {
  std::string service;
  if (!ReadService(env, info, service))
    return Failure(env, "unknown");
  napi_value refusal;
  if (!ReadyForKeychain(env, refusal))
    return refusal;
  CFMutableDictionaryRef query = Query(service);
  CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecReturnRef, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
  CFTypeRef resultValue = nullptr;
  const OSStatus status = SecItemCopyMatching(query, &resultValue);
  CFRelease(query);
  if (status != errSecSuccess)
    return Failure(env, StatusCode(status));
  if (resultValue == nullptr ||
      CFGetTypeID(resultValue) != CFDictionaryGetTypeID()) {
    if (resultValue != nullptr)
      CFRelease(resultValue);
    return Failure(env, "unreadable-item");
  }
  CFDictionaryRef result = static_cast<CFDictionaryRef>(resultValue);
  CFTypeRef dataValue = CFDictionaryGetValue(result, kSecValueData);
  CFTypeRef itemValue = CFDictionaryGetValue(result, kSecValueRef);
  if (dataValue == nullptr || CFGetTypeID(dataValue) != CFDataGetTypeID() ||
      itemValue == nullptr ||
      CFGetTypeID(itemValue) != SecKeychainItemGetTypeID()) {
    CFRelease(resultValue);
    return Failure(env, "unreadable-item");
  }
  CFDataRef data = static_cast<CFDataRef>(dataValue);
  if (CFDataGetLength(data) != static_cast<CFIndex>(kKeyBytes)) {
    CFRelease(resultValue);
    return Failure(env, "unreadable-item");
  }
  const PartitionInspection partition = InspectPartition(
      static_cast<SecKeychainItemRef>(const_cast<void *>(itemValue)));
  if (partition != PartitionInspection::kPresent) {
    CFRelease(resultValue);
    return Failure(env, partition == PartitionInspection::kAbsent
                            ? "unreadable-item"
                            : "uninspectable-item");
  }
  napi_value key;
  napi_create_buffer_copy(env, kKeyBytes, CFDataGetBytePtr(data), nullptr,
                          &key);
  CFRelease(resultValue);
  napi_value response = Success(env);
  Set(env, response, "key", key);
  return response;
}

napi_value CreateKey(napi_env env, napi_callback_info info) {
  std::string service;
  if (!ReadService(env, info, service))
    return Failure(env, "unknown");
  napi_value refusal;
  if (!ReadyForKeychain(env, refusal))
    return refusal;
  std::array<unsigned char, kKeyBytes> material{};
  if (SecRandomCopyBytes(kSecRandomDefault, material.size(), material.data()) !=
      errSecSuccess) {
    EraseKey(material);
    return Failure(env, "unknown");
  }
  SecAccessRef access = MakeAccess();
  if (access == nullptr) {
    EraseKey(material);
    return Failure(env, "unknown");
  }
  CFMutableDictionaryRef attributes = Query(service);
  CFDataRef data =
      CFDataCreate(kCFAllocatorDefault, material.data(), material.size());
  if (data == nullptr) {
    CFRelease(attributes);
    CFRelease(access);
    EraseKey(material);
    return Failure(env, "unknown");
  }
  CFDictionarySetValue(attributes, kSecValueData, data);
  CFDictionarySetValue(attributes, kSecAttrAccess, access);
  CFDictionarySetValue(attributes, kSecReturnRef, kCFBooleanTrue);
  CFTypeRef itemValue = nullptr;
  const OSStatus status = SecItemAdd(attributes, &itemValue);
  CFRelease(attributes);
  CFRelease(data);
  CFRelease(access);
  if (status != errSecSuccess) {
    if (itemValue != nullptr)
      CFRelease(itemValue);
    EraseKey(material);
    return Failure(env, StatusCode(status));
  }
  if (itemValue == nullptr ||
      CFGetTypeID(itemValue) != SecKeychainItemGetTypeID()) {
    if (itemValue != nullptr)
      CFRelease(itemValue);
    EraseKey(material);
    return Failure(env, "unreadable-item");
  }
  const PartitionInspection partition = InspectPartition(
      static_cast<SecKeychainItemRef>(const_cast<void *>(itemValue)));
  if (partition != PartitionInspection::kPresent) {
    CFRelease(itemValue);
    EraseKey(material);
    return Failure(env, partition == PartitionInspection::kAbsent
                            ? "unreadable-item"
                            : "uninspectable-item");
  }
  UInt32 persistedLength = 0;
  void *persistedData = nullptr;
  const OSStatus persistedStatus = SecKeychainItemCopyContent(
      static_cast<SecKeychainItemRef>(const_cast<void *>(itemValue)), nullptr,
      nullptr, &persistedLength, &persistedData);
  const bool persistedMatches =
      persistedStatus == errSecSuccess && persistedData != nullptr &&
      persistedLength == static_cast<UInt32>(material.size()) &&
      timingsafe_bcmp(persistedData, material.data(), material.size()) == 0;
  OSStatus freeStatus = errSecSuccess;
  if (persistedData != nullptr)
    freeStatus = SecKeychainItemFreeContent(nullptr, persistedData);
  CFRelease(itemValue);
  if (persistedStatus != errSecSuccess) {
    EraseKey(material);
    return Failure(env, StatusCode(persistedStatus));
  }
  if (freeStatus != errSecSuccess) {
    EraseKey(material);
    return Failure(env, "uninspectable-item");
  }
  if (!persistedMatches) {
    EraseKey(material);
    return Failure(env, "unreadable-item");
  }
  napi_value key;
  napi_create_buffer_copy(env, material.size(), material.data(), nullptr, &key);
  EraseKey(material);
  napi_value response = Success(env);
  Set(env, response, "key", key);
  return response;
}

napi_value DeleteKey(napi_env env, napi_callback_info info) {
  std::string service;
  if (!ReadService(env, info, service))
    return Failure(env, "unknown");
  napi_value refusal;
  if (!ReadyForKeychain(env, refusal))
    return refusal;
  CFMutableDictionaryRef query = Query(service);
  const OSStatus status = SecItemDelete(query);
  CFRelease(query);
  if (status != errSecSuccess && status != errSecItemNotFound) {
    return Failure(env, StatusCode(status));
  }
  napi_value response = Success(env);
  napi_value deleted;
  napi_get_boolean(env, status == errSecSuccess, &deleted);
  Set(env, response, "deleted", deleted);
  return response;
}

}

NAPI_MODULE_INIT() {
  const napi_property_descriptor properties[] = {
      {"probe", nullptr, Probe, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"readKey", nullptr, ReadKey, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"createKey", nullptr, CreateKey, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"deleteKey", nullptr, DeleteKey, nullptr, nullptr, nullptr, napi_default,
       nullptr},
  };
  napi_define_properties(
      env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
