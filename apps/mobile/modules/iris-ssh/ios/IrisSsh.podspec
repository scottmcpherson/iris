Pod::Spec.new do |s|
  s.name           = 'IrisSsh'
  s.version        = '1.0.0'
  s.summary        = 'Iris mobile SSH bridge'
  s.description    = 'Native SSH bridge used by Iris Mobile development builds.'
  s.author         = 'Nous Research'
  s.homepage       = 'https://github.com/nousresearch/iris'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'NMSSH', '~> 2.3'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
